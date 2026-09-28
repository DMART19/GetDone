import { describe, expect, it } from "vitest";
import type { AuthorizationGrant } from "@/lib/authorization/grants";
import { assembleContext } from "@/lib/intelligence/context";
import {
  createOwnerIntentContextSnapshot,
  createOwnerIntentOrchestrationRun
} from "@/lib/orchestration/owner-intent-flow";
import {
  createPersistedPlanProposal,
  createPlannerInputEnvelope,
  type OrchestrationPlanProposalStore,
  type PersistedPlanProposal
} from "@/lib/orchestration/planning-flow";
import {
  createDurableValidationArtifact,
  type DurableValidationArtifact,
  type OrchestrationValidationArtifactStore
} from "@/lib/orchestration/validation-policy-flow";
import {
  transitionOrchestrationRun,
  type OrchestrationRunRecord
} from "@/lib/orchestration/contracts";
import {
  advanceAuthorizedToTasksCreated,
  advanceTasksCreatedToJobsEnqueued,
  orchestrationJobId,
  type OrchestrationGeneratedTaskStore,
  type OrchestrationJobAuthorityMaterializer,
  type OrchestrationTaskAuthorityMaterializer
} from "@/lib/orchestration/task-job-materialization-flow";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { TaskRecord } from "@/lib/domain/services/task-service";
import {
  TaskGenerator,
  type GeneratedTask
} from "@/lib/planning/task-generator";
import { validPlan } from "@/lib/planning/test-fixture";
import {
  attestPlanValidation
} from "@/lib/planning/plan-validator";
import {
  createValidationReceipt,
  createValidationSnapshot
} from "@/lib/planning/validation-receipt";
import {
  autoGrantFor,
  fixtureNow,
  validationPolicyFor
} from "@/lib/planning/test-security-fixture";
import { CURRENT_POLICY_VERSION } from "@/lib/domain/policy-registry";

class PlanStore implements OrchestrationPlanProposalStore {
  constructor(readonly value: PersistedPlanProposal) {}
  async create() {
    return { status: "idempotent-replay" as const, artifact: this.value };
  }
  async get(id: string) {
    return id === this.value.id ? this.value : null;
  }
  async getByRunVersion(runId: string, version: number) {
    return this.value.runId === runId && this.value.planningRunVersion === version
      ? this.value
      : null;
  }
}

class ValidationStore implements OrchestrationValidationArtifactStore {
  constructor(readonly value: DurableValidationArtifact) {}
  async create() {
    return { status: "idempotent-replay" as const, artifact: this.value };
  }
  async get(id: string) {
    return id === this.value.id ? this.value : null;
  }
  async getByRunVersion(runId: string, version: number) {
    return this.value.runId === runId && this.value.plannedRunVersion === version
      ? this.value
      : null;
  }
}

class GrantStore {
  constructor(readonly values: ReadonlyMap<string, AuthorizationGrant>) {}
  async get(id: string) {
    return this.values.get(id) ?? null;
  }
}

class GeneratedStore implements OrchestrationGeneratedTaskStore {
  readonly values = new Map<string, GeneratedTask>();
  readonly logical = new Map<string, GeneratedTask>();

  async claim(task: GeneratedTask) {
    const existing = this.logical.get(task.logicalKey);
    if (existing) {
      return {
        created: false,
        task: existing,
        consumption: existing.authorizationConsumption
      };
    }
    this.values.set(task.id, task);
    this.logical.set(task.logicalKey, task);
    return {
      created: true,
      task,
      consumption: task.authorizationConsumption
    };
  }

  async get(id: string) {
    return this.values.get(id) ?? null;
  }
}

class TaskAuthority implements OrchestrationTaskAuthorityMaterializer {
  readonly dependencies = new Map<string, readonly string[]>();

  async materialize(input: {
    run: OrchestrationRunRecord;
    task: GeneratedTask;
    dependencyTaskIds: readonly string[];
    grant: AuthorizationGrant;
  }): Promise<TaskRecord> {
    this.dependencies.set(input.task.id, [...input.dependencyTaskIds]);
    return {
      id: input.task.id,
      correlationId: input.run.correlationId,
      portfolioId: input.run.scope.portfolioId,
      companyId: input.run.scope.companyId,
      state: "authorized",
      reason: input.task.reason,
      evidenceIds: input.task.evidenceIds,
      capabilityRequirements: input.task.capabilityRequirements,
      dependencyTaskIds: [...input.dependencyTaskIds],
      authorizationLineage: [input.grant.id],
      authorizationGrantId: input.grant.id,
      authorizationGrantHash: input.grant.grantHash,
      authorizationConsumption: input.task.authorizationConsumption,
      verificationEvidenceIds: [],
      version: 2,
      updatedAt: input.task.createdAt
    };
  }
}

class JobAuthority implements OrchestrationJobAuthorityMaterializer {
  readonly jobs = new Map<string, JobRecord>();
  readonly enqueued: string[] = [];

  async materialize(input: {
    run: OrchestrationRunRecord;
    task: GeneratedTask;
    operationIndex: number;
    dependencyJobIds: readonly string[];
  }): Promise<JobRecord> {
    const id = orchestrationJobId(
      input.run.id,
      input.task.planStepId,
      input.operationIndex
    );
    const prior = this.jobs.get(id);
    if (prior) return prior;
    const record: JobRecord = {
      id,
      correlationId: input.run.correlationId,
      portfolioId: input.run.scope.portfolioId,
      companyId: input.run.scope.companyId,
      state: "created",
      taskId: input.task.id,
      dependencyJobIds: [...input.dependencyJobIds],
      attempt: 0,
      maxAttempts: 5,
      verificationEvidenceIds: [],
      version: 1,
      updatedAt: fixtureNow.toISOString()
    };
    this.jobs.set(id, record);
    return record;
  }

  async enqueue(input: {
    task: GeneratedTask;
    job: JobRecord;
  }): Promise<JobRecord> {
    this.enqueued.push(input.job.id);
    const queued: JobRecord = {
      ...input.job,
      state: "queued",
      authorizationGrantId: input.task.authorizationGrantId,
      authorizationGrantHash: input.task.authorizationGrantHash,
      authorizationConsumption: input.task.authorizationConsumption,
      version: input.job.version + 1
    };
    this.jobs.set(queued.id, queued);
    return queued;
  }
}

function twoStepPlan() {
  const base = validPlan({
    source: {
      type: "owner-request",
      requestId: "intent-materialize"
    },
    objective: undefined,
    createdAt: "2026-09-20T18:29:03.000Z"
  });
  const first = base.steps[0]!;
  return {
    ...base,
    id: "plan-materialize",
    estimatedCostCents: first.estimatedCostCents * 2,
    steps: [
      first,
      {
        ...first,
        id: "step-2",
        title: "Inspect repository again after first result",
        dependsOn: [first.id]
      }
    ]
  };
}

function duplicateActionPlan() {
  const base = validPlan({
    source: {
      type: "owner-request",
      requestId: "intent-logical-key"
    },
    objective: undefined
  });
  const first = base.steps[0]!;
  return {
    ...base,
    id: "plan-logical-key",
    estimatedCostCents: first.estimatedCostCents * 2,
    steps: [
      first,
      {
        ...first,
        id: "step-2",
        title: "Repeat exact authorized operation",
        dependsOn: [first.id]
      }
    ]
  };
}

function buildAuthorized() {
  const plan = twoStepPlan();
  const intent = {
    id: "intent-materialize",
    correlationId: "correlation-materialize",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging" as const,
    userId: "owner-a",
    message: "complete this objective",
    channel: "chat" as const,
    status: "accepted" as const,
    receivedAt: "2026-09-20T18:29:00.000Z"
  };
  const accepted = createOwnerIntentOrchestrationRun(intent);
  const assembled = assembleContext([], {
    portfolioId: "portfolio-a",
    companyId: "company-a",
    allowedSensitivity: ["public", "internal", "customer"]
  }, {
    now: Date.parse("2026-09-20T18:29:01.000Z")
  });
  const context = createOwnerIntentContextSnapshot({
    run: accepted,
    intent,
    assembledContext: assembled,
    createdAt: "2026-09-20T18:29:01.000Z"
  });
  const contextReady = transitionOrchestrationRun(accepted, {
    to: "context-ready",
    now: "2026-09-20T18:29:01.000Z",
    checkpointPatch: {
      contextSnapshot: { id: context.id, hash: context.snapshotHash }
    }
  });
  const plannerInput = createPlannerInputEnvelope({
    run: contextReady,
    snapshot: context,
    createdAt: "2026-09-20T18:29:02.000Z"
  });
  const planning = transitionOrchestrationRun(contextReady, {
    to: "planning",
    now: "2026-09-20T18:29:02.000Z",
    checkpointPatch: {
      plannerInput: { id: plannerInput.id, hash: plannerInput.inputHash }
    }
  });
  const planArtifact = createPersistedPlanProposal({
    run: planning,
    plannerInput,
    plannerRequestId: "planner-request-materialize",
    proposal: plan,
    createdAt: "2026-09-20T18:29:03.000Z"
  });
  const planned = transitionOrchestrationRun(planning, {
    to: "planned",
    now: "2026-09-20T18:29:04.000Z",
    checkpointPatch: {
      plan: { id: planArtifact.id, hash: planArtifact.planHash }
    }
  });

  const policy = validationPolicyFor(plan);
  const validationSnapshot = createValidationSnapshot({
    id: "validation-snapshot-materialize",
    policyVersion: CURRENT_POLICY_VERSION,
    environment: "staging",
    configurationVersion: "materialize-test-v1",
    evidenceRequirements: {
      health: "not-applicable",
      capacity: "not-applicable",
      credentials: "not-applicable"
    },
    createdAt: "2026-09-20T18:29:05.000Z",
    expiresAt: "2026-09-20T18:35:00.000Z"
  });
  const attestation = attestPlanValidation(
    plan,
    policy,
    "2026-09-20T18:29:05.000Z"
  );
  const receipt = createValidationReceipt({
    id: "validation-receipt-materialize",
    plan,
    attestation,
    snapshot: validationSnapshot,
    validatedAt: "2026-09-20T18:29:05.000Z",
    expiresAt: "2026-09-20T18:34:00.000Z"
  });
  const validationArtifact = createDurableValidationArtifact({
    run: planned,
    planArtifact,
    validationPolicy: policy,
    snapshot: validationSnapshot,
    attestation,
    receipt,
    createdAt: "2026-09-20T18:29:05.000Z"
  });
  const validated = transitionOrchestrationRun(planned, {
    to: "validated",
    now: "2026-09-20T18:29:06.000Z",
    checkpointPatch: {
      validationReceipt: { id: receipt.id, hash: receipt.receiptHash }
    }
  });
  const policyEvaluated = transitionOrchestrationRun(validated, {
    to: "policy-evaluated",
    now: "2026-09-20T18:29:07.000Z",
    checkpointPatch: {
      policySnapshot: {
        id: "policy-materialize",
        hash: "a".repeat(64)
      }
    }
  });

  const grants = new Map(
    plan.steps.map((step) => {
      const grant = autoGrantFor(plan, step.id, receipt, fixtureNow);
      return [grant.id, grant] as const;
    })
  );
  const authorized = transitionOrchestrationRun(policyEvaluated, {
    to: "authorized",
    now: fixtureNow.toISOString(),
    checkpointPatch: {
      authorizationGrants: [...grants.values()].map((grant) => ({
        id: grant.id,
        hash: grant.grantHash,
        disposition: grant.disposition
      }))
    }
  });

  return {
    plan,
    receipt,
    planArtifact,
    validationArtifact,
    authorized,
    plans: new PlanStore(planArtifact),
    validations: new ValidationStore(validationArtifact),
    grants: new GrantStore(grants)
  };
}

describe("TaskGenerator DAG identity", () => {
  it("does not collapse distinct Plan steps that request the same operation", async () => {
    const plan = duplicateActionPlan();
    const receipt = createValidationReceipt({
      id: "duplicate-action-receipt",
      plan,
      attestation: attestPlanValidation(
        plan,
        validationPolicyFor(plan),
        "2026-09-20T18:29:59.000Z"
      ),
      snapshot: createValidationSnapshot({
        id: "duplicate-action-snapshot",
        policyVersion: CURRENT_POLICY_VERSION,
        environment: "staging",
        configurationVersion: "duplicate-action-v1",
        evidenceRequirements: {
          health: "not-applicable",
          capacity: "not-applicable",
          credentials: "not-applicable"
        },
        createdAt: "2026-09-20T18:29:58.000Z",
        expiresAt: "2026-09-20T18:35:00.000Z"
      }),
      validatedAt: "2026-09-20T18:29:59.000Z",
      expiresAt: "2026-09-20T18:34:00.000Z"
    });
    const grants = Object.fromEntries(
      plan.steps.map((step) => {
        const grant = autoGrantFor(plan, step.id, receipt, fixtureNow);
        return [step.id, grant];
      })
    );
    const store = new GeneratedStore();
    let id = 0;
    const result = await new TaskGenerator(
      store,
      () => `task-${++id}`,
      () => fixtureNow
    ).generate({
      plan,
      validationReceipt: receipt,
      authorizationGrants: grants
    });

    expect(result.status).toBe("created");
    expect(result.tasks).toHaveLength(2);
    expect(new Set(result.tasks.map((task) => task.logicalKey)).size).toBe(2);
  });
});

describe("authorized -> Task DAG -> Job DAG", () => {
  it("materializes exact Tasks, preserves dependencies, and enqueues only runnable root Jobs", async () => {
    const built = buildAuthorized();
    const generatedTasks = new GeneratedStore();
    const taskAuthority = new TaskAuthority();

    const taskStage = await advanceAuthorizedToTasksCreated({
      run: built.authorized,
      plans: built.plans,
      validations: built.validations,
      grants: built.grants,
      generatedTasks,
      taskAuthority,
      now: () => fixtureNow
    });
    expect(taskStage.kind).toBe("advance");
    if (taskStage.kind !== "advance") throw new Error("Task stage must advance");
    expect(taskStage.next.state).toBe("tasks-created");
    expect(taskStage.next.checkpoints.tasks).toHaveLength(2);
    expect(taskAuthority.dependencies.get(
      `task:${built.authorized.id}:step-2`
    )).toEqual([
      `task:${built.authorized.id}:step-1`
    ]);

    const jobs = new JobAuthority();
    const jobStage = await advanceTasksCreatedToJobsEnqueued({
      run: taskStage.next,
      plans: built.plans,
      validations: built.validations,
      grants: built.grants,
      generatedTasks,
      jobAuthority: jobs,
      now: () => fixtureNow
    });
    expect(jobStage.kind).toBe("advance");
    if (jobStage.kind !== "advance") throw new Error("Job stage must advance");
    expect(jobStage.next.state).toBe("jobs-enqueued");
    expect(jobStage.next.checkpoints.jobIds).toEqual([
      orchestrationJobId(built.authorized.id, "step-1", 0),
      orchestrationJobId(built.authorized.id, "step-2", 0)
    ]);
    expect(jobs.enqueued).toEqual([
      orchestrationJobId(built.authorized.id, "step-1", 0)
    ]);
    expect(jobs.jobs.get(
      orchestrationJobId(built.authorized.id, "step-2", 0)
    )?.dependencyJobIds).toEqual([
      orchestrationJobId(built.authorized.id, "step-1", 0)
    ]);
  });

  it("replays Task materialization with stable deterministic identities after a crash before run CAS", async () => {
    const built = buildAuthorized();
    const generatedTasks = new GeneratedStore();
    const taskAuthority = new TaskAuthority();

    const first = await advanceAuthorizedToTasksCreated({
      run: built.authorized,
      plans: built.plans,
      validations: built.validations,
      grants: built.grants,
      generatedTasks,
      taskAuthority,
      now: () => fixtureNow
    });
    const replay = await advanceAuthorizedToTasksCreated({
      run: built.authorized,
      plans: built.plans,
      validations: built.validations,
      grants: built.grants,
      generatedTasks,
      taskAuthority,
      now: () => fixtureNow
    });

    expect(first.kind).toBe("advance");
    expect(replay.kind).toBe("advance");
    if (first.kind !== "advance" || replay.kind !== "advance") {
      throw new Error("Task stage must advance");
    }
    expect(replay.next.checkpoints.tasks).toEqual(first.next.checkpoints.tasks);
    expect(generatedTasks.values.size).toBe(2);
  });

  it("fails closed when a generated Task checkpoint is tampered", async () => {
    const built = buildAuthorized();
    const generatedTasks = new GeneratedStore();
    const first = await advanceAuthorizedToTasksCreated({
      run: built.authorized,
      plans: built.plans,
      validations: built.validations,
      grants: built.grants,
      generatedTasks,
      taskAuthority: new TaskAuthority(),
      now: () => fixtureNow
    });
    if (first.kind !== "advance") throw new Error("Task stage must advance");

    const tampered = {
      ...first.next,
      checkpoints: {
        ...first.next.checkpoints,
        tasks: first.next.checkpoints.tasks.map((task, index) =>
          index === 0 ? { ...task, hash: "f".repeat(64) } : task
        )
      }
    };

    await expect(advanceTasksCreatedToJobsEnqueued({
      run: tampered as OrchestrationRunRecord,
      plans: built.plans,
      validations: built.validations,
      grants: built.grants,
      generatedTasks,
      jobAuthority: new JobAuthority(),
      now: () => fixtureNow
    })).rejects.toThrow(/tampered/i);
  });
});
