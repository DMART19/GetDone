import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { AuthorizationGrant } from "@/lib/authorization/grants";
import type { TaskRecord, TaskService } from "@/lib/domain/services/task-service";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import type { OrchestrationExecutionArtifactStore } from "@/lib/orchestration/execution-artifact-store";
import {
  createTaskDagExecutionArtifact,
  executionArtifactId,
  type TaskDagExecutionArtifact
} from "@/lib/orchestration/execution-artifacts";
import type { OrchestrationPlanningArtifactStore } from "@/lib/orchestration/planning-artifact-store";
import { assertGovernedPlanArtifactIntegrity } from "@/lib/orchestration/planning-artifacts";
import { DagCompiler } from "@/lib/planning/dag-compiler";
import {
  TaskGenerator,
  type GeneratedTask,
  type TaskGenerationDedupeStore
} from "@/lib/planning/task-generator";

export interface GovernedTaskReadStore {
  get(id: string): Promise<TaskRecord | null>;
}

function scopeFor(task: GeneratedTask): TrustedExecutionScope {
  return Object.freeze({
    userId: task.scope.userId,
    portfolioId: task.scope.portfolioId,
    companyId: task.scope.companyId,
    environment: task.scope.environment,
    resourceId: task.scope.resourceId
  });
}

function taskCommand(input: {
  run: OrchestrationRun;
  task: GeneratedTask;
  action: string;
}) {
  return createCommandEnvelope({
    commandId: `command:${sha256Hex({
      runId: input.run.id,
      taskId: input.task.id,
      action: input.action
    })}`,
    actor: { type: "system", id: "orchestration" },
    scope: scopeFor(input.task),
    correlationId: input.run.correlationId,
    environment: input.task.scope.environment,
    idempotencyKey: `orchestration:${input.run.id}:task:${input.task.id}:${input.action}`,
    provenance: "orchestration:task-materializer",
    requestedMutation: {
      type: `task.${input.action}`,
      taskId: input.task.id
    }
  });
}

function stableTaskIdFactory(run: OrchestrationRun, planHash: string) {
  let index = 0;
  return () => {
    const id = `task:orchestration:${sha256Hex({
      runId: run.id,
      planHash,
      index
    })}`;
    index += 1;
    return id;
  };
}

export class GovernedTaskMaterializer {
  constructor(
    private readonly planning: OrchestrationPlanningArtifactStore,
    private readonly execution: OrchestrationExecutionArtifactStore,
    private readonly dedupe: TaskGenerationDedupeStore,
    private readonly taskService: TaskService,
    private readonly taskReads: GovernedTaskReadStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async materialize(run: OrchestrationRun): Promise<TaskDagExecutionArtifact> {
    const [planArtifact, validationArtifact, authorization] = await Promise.all([
      this.planning.latestPlan(run),
      this.planning.latestValidation(run),
      this.execution.latestAuthorizationBundle(run)
    ]);
    const validationReceiptArtifact = await this.execution.latestValidationReceipt(run);

    if (
      !planArtifact
      || !validationArtifact
      || !authorization
      || !validationReceiptArtifact
    ) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Task materialization requires plan, validation receipt, and authorization bundle"
      );
    }
    assertGovernedPlanArtifactIntegrity(planArtifact);

    if (
      authorization.planHash !== planArtifact.planHash
      || validationReceiptArtifact.planHash !== planArtifact.planHash
      || authorization.validationReceiptHash
        !== validationReceiptArtifact.receipt.receiptHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Task materialization authorization lineage does not match the governed plan"
      );
    }

    const grantsByStep = Object.fromEntries(
      authorization.grants.map((grant) => [grant.stepId, grant])
    ) as Record<string, AuthorizationGrant>;

    const generator = new TaskGenerator(
      this.dedupe,
      stableTaskIdFactory(run, planArtifact.planHash),
      this.now
    );
    const generated = await generator.generate({
      plan: planArtifact.plan,
      validationReceipt: validationReceiptArtifact.receipt,
      authorizationGrants: grantsByStep
    });

    if (generated.status === "blocked") {
      throw new ControlPlaneError(
        "POLICY_BLOCKED",
        generated.reasons.join("; ") || "Task generation was blocked"
      );
    }

    const allTasks = [...generated.tasks, ...generated.duplicateTasks];
    const byLogicalKey = new Map(allTasks.map((task) => [task.logicalKey, task]));

    for (const task of allTasks) {
      const grant = grantsByStep[task.planStepId];
      if (!grant || grant.id !== task.authorizationGrantId) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Generated Task lost exact AuthorizationGrant lineage"
        );
      }

      let record = await this.taskReads.get(task.id);
      const dependencyTaskIds = task.dependsOnLogicalKeys.map((key) => {
        const dependency = byLogicalKey.get(key);
        if (!dependency) {
          throw new ControlPlaneError(
            "CONFLICT",
            `Generated Task dependency is missing: ${key}`
          );
        }
        return dependency.id;
      });

      if (!record) {
        record = await this.taskService.create({
          id: task.id,
          reason: task.reason,
          evidenceIds: task.evidenceIds,
          capabilityRequirements: task.capabilityRequirements,
          dependencyTaskIds,
          createdAt: task.createdAt
        }, taskCommand({ run, task, action: "create" }));
      }

      if (record.state === "proposed") {
        record = await this.taskService.authorize(
          task.id,
          taskCommand({ run, task, action: "authorize" }),
          grant,
          task.authorizationConsumption.consumedAt
        );
      }

      if (
        !["authorized", "queued", "running", "verifying", "succeeded"].includes(record.state)
        || record.authorizationGrantId !== grant.id
        || record.authorizationGrantHash !== grant.grantHash
        || record.authorizationConsumption?.consumptionHash
          !== task.authorizationConsumption.consumptionHash
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Authoritative Task does not preserve generated authorization lineage"
        );
      }
    }

    const dag = new DagCompiler(
      () => `dag:orchestration:${sha256Hex({
        runId: run.id,
        planHash: planArtifact.planHash
      })}`,
      this.now
    ).compile(allTasks);

    const artifact = createTaskDagExecutionArtifact({
      id: executionArtifactId({
        kind: "task-dag",
        run,
        predecessorHash: authorization.artifactHash
      }),
      runId: run.id,
      correlationId: run.correlationId,
      planHash: planArtifact.planHash,
      authorizationBundleId: authorization.id,
      tasks: allTasks,
      dag,
      createdAt: this.now().toISOString()
    });

    await this.execution.append(run, {
      kind: "task-dag",
      value: artifact
    });
    return artifact;
  }
}
