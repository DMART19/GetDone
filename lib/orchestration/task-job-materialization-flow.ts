import { assertAuthorizationGrant, type AuthorizationGrant } from "@/lib/authorization/grants";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { TaskRecord } from "@/lib/domain/services/task-service";
import {
  transitionOrchestrationRun,
  type OrchestrationRunRecord
} from "@/lib/orchestration/contracts";
import type { OrchestrationStageOutcome } from "@/lib/orchestration/worker-contracts";
import {
  assertPersistedPlanProposal,
  type OrchestrationPlanProposalStore,
  type PersistedPlanProposal
} from "@/lib/orchestration/planning-flow";
import {
  assertDurableValidationArtifact,
  type DurableValidationArtifact,
  type OrchestrationValidationArtifactStore
} from "@/lib/orchestration/validation-policy-flow";
import {
  TaskGenerator,
  type GeneratedTask,
  type TaskGenerationDedupeStore
} from "@/lib/planning/task-generator";

export interface OrchestrationAuthorizationGrantReadStore {
  get(id: string): Promise<AuthorizationGrant | null>;
}

export interface OrchestrationGeneratedTaskStore extends TaskGenerationDedupeStore {
  get(id: string): Promise<GeneratedTask | null>;
}

export interface OrchestrationObjectiveStatusStore {
  getStatus(objectiveId: string): Promise<"active" | "paused" | "completed" | null>;
}

export interface OrchestrationTaskAuthorityMaterializer {
  materialize(input: {
    run: OrchestrationRunRecord;
    task: GeneratedTask;
    dependencyTaskIds: readonly string[];
    grant: AuthorizationGrant;
  }): Promise<TaskRecord>;
}

export interface OrchestrationJobAuthorityMaterializer {
  materialize(input: {
    run: OrchestrationRunRecord;
    task: GeneratedTask;
    grant: AuthorizationGrant;
    operationIndex: number;
    dependencyJobIds: readonly string[];
  }): Promise<JobRecord>;

  enqueue(input: {
    run: OrchestrationRunRecord;
    task: GeneratedTask;
    grant: AuthorizationGrant;
    operationIndex: number;
    job: JobRecord;
  }): Promise<JobRecord>;
}

interface MaterializationLineage {
  planArtifact: PersistedPlanProposal;
  validationArtifact: DurableValidationArtifact;
  grantsByStep: ReadonlyMap<string, AuthorizationGrant>;
}

function taskId(runId: string, stepId: string) {
  return `task:${runId}:${stepId}`;
}

export function orchestrationJobId(
  runId: string,
  stepId: string,
  operationIndex: number
) {
  if (!Number.isInteger(operationIndex) || operationIndex < 0) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Job operation index must be a non-negative integer"
    );
  }
  return `job:${runId}:${stepId}:op:${operationIndex + 1}`;
}

async function loadMaterializationLineage(input: {
  run: OrchestrationRunRecord;
  plans: OrchestrationPlanProposalStore;
  validations: OrchestrationValidationArtifactStore;
  grants: OrchestrationAuthorizationGrantReadStore;
  now: Date;
}): Promise<MaterializationLineage> {
  const planRef = input.run.checkpoints.plan;
  const validationRef = input.run.checkpoints.validationReceipt;
  if (!planRef || !validationRef) {
    throw new ControlPlaneError(
      "CONFLICT",
      "Task/Job materialization requires Plan and validation checkpoints",
      { correlationId: input.run.correlationId }
    );
  }

  const planArtifact = await input.plans.get(planRef.id);
  if (!planArtifact) {
    throw new ControlPlaneError("FORBIDDEN", "Persisted Plan artifact is missing");
  }
  assertPersistedPlanProposal(planArtifact);

  const validationArtifact = await input.validations.get(validationRef.id);
  if (!validationArtifact) {
    throw new ControlPlaneError("FORBIDDEN", "Persisted validation artifact is missing");
  }
  assertDurableValidationArtifact(validationArtifact, planArtifact);

  if (
    planArtifact.runId !== input.run.id
    || planArtifact.portfolioId !== input.run.scope.portfolioId
    || planArtifact.companyId !== input.run.scope.companyId
    || planArtifact.planHash !== planRef.hash
    || validationArtifact.runId !== input.run.id
    || validationArtifact.portfolioId !== input.run.scope.portfolioId
    || validationArtifact.companyId !== input.run.scope.companyId
    || validationArtifact.receipt.receiptHash !== validationRef.hash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Task/Job materialization lineage does not match orchestration tenant/checkpoints",
      { correlationId: input.run.correlationId }
    );
  }

  const grantRefs = input.run.checkpoints.authorizationGrants;
  if (grantRefs.length !== planArtifact.proposal.steps.length) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Authorized orchestration must contain exactly one grant per Plan step"
    );
  }

  const grantsByStep = new Map<string, AuthorizationGrant>();
  for (const ref of grantRefs) {
    const grant = await input.grants.get(ref.id);
    if (
      !grant
      || grant.grantHash !== ref.hash
      || grant.disposition !== ref.disposition
      || grantsByStep.has(grant.stepId)
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Authorization grant checkpoint is missing, tampered, or duplicated"
      );
    }

    assertAuthorizationGrant({
      grant,
      plan: planArtifact.proposal,
      stepId: grant.stepId,
      receipt: validationArtifact.receipt,
      scope: input.run.scope,
      now: input.now.getTime()
    });
    grantsByStep.set(grant.stepId, grant);
  }

  for (const step of planArtifact.proposal.steps) {
    if (!grantsByStep.has(step.id)) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        `Authorized Plan step has no exact grant: ${step.id}`
      );
    }
  }

  return {
    planArtifact,
    validationArtifact,
    grantsByStep
  };
}

function assertAuthoritativeTask(
  record: TaskRecord,
  run: OrchestrationRunRecord,
  task: GeneratedTask,
  dependencyTaskIds: readonly string[]
) {
  if (
    record.id !== task.id
    || record.portfolioId !== run.scope.portfolioId
    || record.companyId !== run.scope.companyId
    || record.state !== "authorized"
    || record.authorizationGrantId !== task.authorizationGrantId
    || record.authorizationGrantHash !== task.authorizationGrantHash
    || record.authorizationConsumption?.consumptionHash
      !== task.authorizationConsumption.consumptionHash
    || JSON.stringify([...(record.dependencyTaskIds ?? [])])
      !== JSON.stringify([...dependencyTaskIds])
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Authoritative Task materialization did not preserve exact Plan/authorization lineage",
      { correlationId: run.correlationId }
    );
  }
}

function assertMaterializedJob(
  record: JobRecord,
  run: OrchestrationRunRecord,
  task: GeneratedTask,
  expectedId: string,
  dependencyJobIds: readonly string[]
) {
  if (
    record.id !== expectedId
    || record.taskId !== task.id
    || record.portfolioId !== run.scope.portfolioId
    || record.companyId !== run.scope.companyId
    || !["created", "queued"].includes(record.state)
    || JSON.stringify([...(record.dependencyJobIds ?? [])])
      !== JSON.stringify([...dependencyJobIds])
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Authoritative Job materialization did not preserve Task/DAG lineage",
      { correlationId: run.correlationId }
    );
  }
}

export async function advanceAuthorizedToTasksCreated(input: {
  run: OrchestrationRunRecord;
  plans: OrchestrationPlanProposalStore;
  validations: OrchestrationValidationArtifactStore;
  grants: OrchestrationAuthorizationGrantReadStore;
  generatedTasks: OrchestrationGeneratedTaskStore;
  taskAuthority: OrchestrationTaskAuthorityMaterializer;
  objectives?: OrchestrationObjectiveStatusStore;
  now?: () => Date;
}): Promise<OrchestrationStageOutcome> {
  if (input.run.state !== "authorized") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Task materialization requires authorized orchestration state",
      { correlationId: input.run.correlationId }
    );
  }

  const now = input.now ?? (() => new Date());
  const instant = now();
  const lineage = await loadMaterializationLineage({
    ...input,
    now: instant
  });

  let objectiveStatus: "active" | "paused" | "completed" | undefined;
  if (lineage.planArtifact.proposal.source.type === "objective") {
    if (!input.objectives) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "Objective-backed autonomous work requires authoritative objective status"
      );
    }
    const status = await input.objectives.getStatus(
      lineage.planArtifact.proposal.source.objectiveId
    );
    if (!status) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Objective-backed Plan references a missing authoritative objective"
      );
    }
    objectiveStatus = status;
  }

  let idIndex = 0;
  const generator = new TaskGenerator(
    input.generatedTasks,
    () => {
      const step = lineage.planArtifact.proposal.steps[idIndex++];
      if (!step) {
        throw new ControlPlaneError(
          "CONFLICT",
          "Task generator requested more IDs than the frozen Plan contains"
        );
      }
      return taskId(input.run.id, step.id);
    },
    () => instant
  );

  const grants = Object.fromEntries(
    [...lineage.grantsByStep.entries()]
  );

  const generated = await generator.generate({
    plan: lineage.planArtifact.proposal,
    validationReceipt: lineage.validationArtifact.receipt,
    authorizationGrants: grants,
    objectiveStatus
  });

  if (generated.status === "blocked") {
    return {
      kind: "advance",
      next: transitionOrchestrationRun(input.run, {
        to: "blocked",
        now: instant.toISOString(),
        blockedReason: generated.reasons.join("; ") || "Task generation was blocked"
      })
    };
  }

  const allTasks = [...generated.tasks, ...generated.duplicateTasks];
  const byStep = new Map(allTasks.map((task) => [task.planStepId, task]));
  if (
    allTasks.length !== lineage.planArtifact.proposal.steps.length
    || byStep.size !== lineage.planArtifact.proposal.steps.length
  ) {
    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Task generation did not resolve to exactly one durable Task per Plan step"
    );
  }

  const byLogicalKey = new Map(allTasks.map((task) => [task.logicalKey, task]));
  const ordered: GeneratedTask[] = [];
  for (const step of lineage.planArtifact.proposal.steps) {
    const task = byStep.get(step.id);
    const grant = lineage.grantsByStep.get(step.id);
    if (!task || !grant || task.id !== taskId(input.run.id, step.id)) {
      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        `Durable Task identity drifted for Plan step: ${step.id}`
      );
    }
    ordered.push(task);

    const dependencyTaskIds = task.dependsOnLogicalKeys.map((logicalKey) => {
      const dependency = byLogicalKey.get(logicalKey);
      if (!dependency) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Generated Task dependency does not resolve inside the frozen Plan DAG"
        );
      }
      return dependency.id;
    });

    const authoritative = await input.taskAuthority.materialize({
      run: input.run,
      task,
      dependencyTaskIds,
      grant
    });
    assertAuthoritativeTask(
      authoritative,
      input.run,
      task,
      dependencyTaskIds
    );
  }

  return {
    kind: "advance",
    next: transitionOrchestrationRun(input.run, {
      to: "tasks-created",
      now: instant.toISOString(),
      checkpointPatch: {
        tasks: ordered.map((task) => Object.freeze({
          id: task.id,
          hash: sha256Hex(task),
          authorizationConsumptionHash:
            task.authorizationConsumption.consumptionHash
        }))
      }
    })
  };
}

export async function advanceTasksCreatedToJobsEnqueued(input: {
  run: OrchestrationRunRecord;
  plans: OrchestrationPlanProposalStore;
  validations: OrchestrationValidationArtifactStore;
  grants: OrchestrationAuthorizationGrantReadStore;
  generatedTasks: OrchestrationGeneratedTaskStore;
  jobAuthority: OrchestrationJobAuthorityMaterializer;
  now?: () => Date;
}): Promise<OrchestrationStageOutcome> {
  if (input.run.state !== "tasks-created") {
    throw new ControlPlaneError(
      "CONFLICT",
      "Job materialization requires tasks-created orchestration state",
      { correlationId: input.run.correlationId }
    );
  }

  const now = input.now ?? (() => new Date());
  const instant = now();
  const lineage = await loadMaterializationLineage({
    ...input,
    now: instant
  });

  const tasks: GeneratedTask[] = [];
  for (const ref of input.run.checkpoints.tasks) {
    const task = await input.generatedTasks.get(ref.id);
    if (
      !task
      || sha256Hex(task) !== ref.hash
      || task.authorizationConsumption.consumptionHash
        !== ref.authorizationConsumptionHash
      || task.scope.portfolioId !== input.run.scope.portfolioId
      || task.scope.companyId !== input.run.scope.companyId
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Generated Task checkpoint is missing, tampered, or outside tenant scope"
      );
    }
    tasks.push(task);
  }

  const byLogicalKey = new Map(tasks.map((task) => [task.logicalKey, task]));
  const terminalJobId = new Map<string, string>();
  for (const task of tasks) {
    if (task.operations.length === 0) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Generated Task must contain at least one authorized operation"
      );
    }
    terminalJobId.set(
      task.logicalKey,
      orchestrationJobId(
        input.run.id,
        task.planStepId,
        task.operations.length - 1
      )
    );
  }

  const materialized: Array<{
    task: GeneratedTask;
    grant: AuthorizationGrant;
    operationIndex: number;
    job: JobRecord;
    dependencyJobIds: readonly string[];
  }> = [];

  for (const task of tasks) {
    const grant = lineage.grantsByStep.get(task.planStepId);
    if (
      !grant
      || grant.id !== task.authorizationGrantId
      || grant.grantHash !== task.authorizationGrantHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Generated Task no longer matches its exact authorization grant"
      );
    }

    for (let operationIndex = 0; operationIndex < task.operations.length; operationIndex += 1) {
      const expectedId = orchestrationJobId(
        input.run.id,
        task.planStepId,
        operationIndex
      );
      const dependencyJobIds = operationIndex > 0
        ? [
            orchestrationJobId(
              input.run.id,
              task.planStepId,
              operationIndex - 1
            )
          ]
        : task.dependsOnLogicalKeys.map((logicalKey) => {
            if (!byLogicalKey.has(logicalKey)) {
              throw new ControlPlaneError(
                "FORBIDDEN",
                "Job DAG references a Task outside the materialized Plan"
              );
            }
            const dependency = terminalJobId.get(logicalKey);
            if (!dependency) {
              throw new ControlPlaneError(
                "CONFLICT",
                "Dependent Task has no terminal Job"
              );
            }
            return dependency;
          });

      const job = await input.jobAuthority.materialize({
        run: input.run,
        task,
        grant,
        operationIndex,
        dependencyJobIds
      });
      assertMaterializedJob(
        job,
        input.run,
        task,
        expectedId,
        dependencyJobIds
      );
      materialized.push({
        task,
        grant,
        operationIndex,
        job,
        dependencyJobIds
      });
    }
  }

  const roots = materialized.filter((item) => item.dependencyJobIds.length === 0);
  if (materialized.length > 0 && roots.length === 0) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Materialized Job DAG has no runnable root"
    );
  }

  for (const root of roots) {
    const queued = await input.jobAuthority.enqueue({
      run: input.run,
      task: root.task,
      grant: root.grant,
      operationIndex: root.operationIndex,
      job: root.job
    });
    if (
      queued.id !== root.job.id
      || queued.state !== "queued"
      || queued.authorizationConsumption?.consumptionHash
        !== root.task.authorizationConsumption.consumptionHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Runnable root Job was not durably admitted with exact Task authorization"
      );
    }
  }

  return {
    kind: "advance",
    next: transitionOrchestrationRun(input.run, {
      to: "jobs-enqueued",
      now: instant.toISOString(),
      checkpointPatch: {
        jobIds: materialized.map((item) => item.job.id)
      }
    })
  };
}
