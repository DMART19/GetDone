import { describe, expect, it, vi } from "vitest";
import type { AuthorizationConsumptionRecord, AuthorizationGrant } from "@/lib/authorization/grants";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { TaskRecord } from "@/lib/domain/services/task-service";
import type { DurableJobStore } from "@/lib/execution/job-runtime-contracts";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import type { OrchestrationExecutionArtifactStore } from "@/lib/orchestration/execution-artifact-store";
import {
  createAuthorizationBundleExecutionArtifact,
  createTaskDagExecutionArtifact,
  type OrchestrationExecutionArtifact,
  type OrchestrationExecutionArtifactKind
} from "@/lib/orchestration/execution-artifacts";
import { GovernedJobMaterializer } from "@/lib/orchestration/governed-job-materializer";
import type { GeneratedTask } from "@/lib/planning/task-generator";

const now = new Date("2026-09-27T21:00:00.000Z");

function run(): OrchestrationRun {
  return Object.freeze({
    id: "run-1",
    correlationId: "corr-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging",
    authorityUserId: "user-a",
    initiatingActor: Object.freeze({ type: "user" as const, id: "user-a" }),
    source: Object.freeze({ kind: "owner-intent" as const, ownerIntentId: "intent-1" }),
    state: "materializing",
    attempt: 1,
    version: 8,
    availableAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  });
}

function consumption(grantId: string, taskId: string): AuthorizationConsumptionRecord {
  return {
    id: `authorization-consumption:${grantId}`,
    grantId,
    consumerType: "task",
    consumerId: taskId,
    consumedAt: now.toISOString(),
    grantHash: `${grantId}-hash`,
    consumptionHash: `${grantId}-consumption`
  } as AuthorizationConsumptionRecord;
}

function generatedTask(input: {
  id: string;
  logicalKey: string;
  stepId: string;
  grantId: string;
  dependencies?: string[];
}): GeneratedTask {
  const auth = consumption(input.grantId, input.id);
  return {
    id: input.id,
    planId: "plan-1",
    planHash: "p".repeat(64),
    planStepId: input.stepId,
    logicalKey: input.logicalKey,
    scope: {
      userId: "user-a",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "staging",
      dataClass: "internal"
    },
    reason: "governed test work",
    evidenceIds: [],
    dependsOnLogicalKeys: input.dependencies ?? [],
    conflictsWithLogicalKeys: [],
    capabilityRequirements: ["repository.inspect"],
    operations: [],
    verificationRequirements: [],
    rollback: { strategy: "none", cancellationAllowed: true },
    resourceRequirements: {
      execution: {
        environment: "staging",
        priority: 50,
        checkpointable: false,
        retryable: true
      },
      reliability: {
        minimumTier: "standard",
        fallbackRequired: false,
        maxInterruptionClass: "brief"
      },
      data: {
        classification: "internal",
        customerData: false,
        allowedRegions: []
      },
      economics: {},
      credentialBindingRequired: false
    },
    authorizationGrantId: input.grantId,
    authorizationGrantHash: `${input.grantId}-hash`,
    authorizationConsumption: auth,
    authorizationLineage: [],
    validationReceiptId: "receipt-1",
    validationReceiptHash: "r".repeat(64),
    createdAt: now.toISOString()
  } as GeneratedTask;
}

class MemoryExecution implements OrchestrationExecutionArtifactStore {
  readonly artifacts: OrchestrationExecutionArtifact[] = [];
  constructor(
    private readonly authorization: ReturnType<typeof createAuthorizationBundleExecutionArtifact>,
    private readonly taskDag: ReturnType<typeof createTaskDagExecutionArtifact>
  ) {}
  async append(_run: OrchestrationRun, artifact: OrchestrationExecutionArtifact) {
    this.artifacts.push(artifact);
    return { created: true };
  }
  async latestValidationReceipt() { return null; }
  async latestAuthorizationBundle() { return this.authorization; }
  async latestTaskDag() { return this.taskDag; }
  async latestJobBatch() {
    const value = [...this.artifacts].reverse().find((item) => item.kind === "job-batch");
    return value?.kind === "job-batch" ? value.value : null;
  }
  async count(_run: OrchestrationRun, kind: OrchestrationExecutionArtifactKind) {
    return this.artifacts.filter((item) => item.kind === kind).length;
  }
}

describe("GovernedJobMaterializer", () => {
  it("materializes the whole Job graph but durably enqueues only dependency-free roots", async () => {
    const root = generatedTask({
      id: "task-root",
      logicalKey: "logical-root",
      stepId: "step-1",
      grantId: "grant-1"
    });
    const child = generatedTask({
      id: "task-child",
      logicalKey: "logical-child",
      stepId: "step-2",
      grantId: "grant-2",
      dependencies: ["logical-root"]
    });
    const grants = [
      {
        id: "grant-1",
        stepId: "step-1",
        grantHash: "grant-1-hash"
      },
      {
        id: "grant-2",
        stepId: "step-2",
        grantHash: "grant-2-hash"
      }
    ] as AuthorizationGrant[];

    const authorization = createAuthorizationBundleExecutionArtifact({
      id: "authorization-artifact-1",
      runId: run().id,
      correlationId: run().correlationId,
      planHash: "p".repeat(64),
      validationReceiptId: "receipt-1",
      validationReceiptHash: "r".repeat(64),
      grants,
      createdAt: now.toISOString()
    });
    const taskDag = createTaskDagExecutionArtifact({
      id: "task-dag-artifact-1",
      runId: run().id,
      correlationId: run().correlationId,
      planHash: "p".repeat(64),
      authorizationBundleId: authorization.id,
      tasks: [root, child],
      dag: { id: "dag-1" } as never,
      createdAt: now.toISOString()
    });
    const execution = new MemoryExecution(authorization, taskDag);

    const taskRecords = new Map<string, TaskRecord>([
      [root.id, {
        id: root.id,
        portfolioId: "portfolio-a",
        companyId: "company-a",
        state: "authorized",
        version: 2,
        updatedAt: now.toISOString(),
        reason: root.reason,
        evidenceIds: [],
        capabilityRequirements: ["repository.inspect"],
        dependencyTaskIds: [],
        authorizationLineage: ["grant-1"],
        authorizationGrantId: "grant-1",
        authorizationGrantHash: "grant-1-hash",
        authorizationConsumption: root.authorizationConsumption,
        verificationEvidenceIds: []
      } as TaskRecord],
      [child.id, {
        id: child.id,
        portfolioId: "portfolio-a",
        companyId: "company-a",
        state: "authorized",
        version: 2,
        updatedAt: now.toISOString(),
        reason: child.reason,
        evidenceIds: [],
        capabilityRequirements: ["repository.inspect"],
        dependencyTaskIds: [root.id],
        authorizationLineage: ["grant-2"],
        authorizationGrantId: "grant-2",
        authorizationGrantHash: "grant-2-hash",
        authorizationConsumption: child.authorizationConsumption,
        verificationEvidenceIds: []
      } as TaskRecord]
    ]);
    const taskQueue = vi.fn(async (id: string) => {
      const current = taskRecords.get(id)!;
      const next = { ...current, state: "queued" as const, version: current.version + 1 };
      taskRecords.set(id, next);
      return next;
    });

    const jobs = new Map<string, JobRecord>();
    const jobCreate = vi.fn(async (input: {
      id: string;
      taskId: string;
      dependencyJobIds: readonly string[];
      createdAt: string;
    }) => {
      const record = {
        id: input.id,
        portfolioId: "portfolio-a",
        companyId: "company-a",
        state: "created",
        taskId: input.taskId,
        dependencyJobIds: input.dependencyJobIds,
        version: 1,
        updatedAt: input.createdAt
      } as JobRecord;
      jobs.set(record.id, record);
      return record;
    });
    const jobQueue = vi.fn(async (
      id: string,
      _command: unknown,
      _grant: AuthorizationGrant,
      auth: AuthorizationConsumptionRecord
    ) => {
      const current = jobs.get(id)!;
      const next = {
        ...current,
        state: "queued" as const,
        version: current.version + 1,
        authorizationGrantId: auth.grantId,
        authorizationGrantHash: auth.grantHash,
        authorizationConsumption: auth
      } as JobRecord;
      jobs.set(id, next);
      return next;
    });
    const durableEnqueue = vi.fn(async () => ({
      snapshot: {} as never,
      transaction: {
        id: "runtime-tx-1",
        jobId: "job-root",
        operation: "enqueue",
        idempotencyKey: "enqueue-root",
        transactionHash: "t".repeat(64),
        occurredAt: now.toISOString()
      } as never,
      idempotentReplay: false
    }));

    const materializer = new GovernedJobMaterializer(
      execution,
      { queue: taskQueue } as never,
      { get: async (id) => taskRecords.get(id) ?? null },
      { create: jobCreate, queue: jobQueue } as never,
      { get: async (id) => jobs.get(id) ?? null },
      { enqueue: durableEnqueue } as unknown as DurableJobStore,
      () => now
    );

    const result = await materializer.materializeAndEnqueue(run());

    expect(jobCreate).toHaveBeenCalledTimes(2);
    expect(taskQueue).toHaveBeenCalledTimes(1);
    expect(jobQueue).toHaveBeenCalledTimes(1);
    expect(durableEnqueue).toHaveBeenCalledTimes(1);
    expect(result.jobs).toHaveLength(2);
    expect(result.enqueued).toHaveLength(1);
    expect(result.providerExecutionSpecsCreated).toBe(false);

    const childJob = result.jobs.find((job) => job.taskId === child.id);
    expect(childJob?.state).toBe("created");
    expect(childJob?.dependencyJobIds).toHaveLength(1);
    expect(await execution.count(run(), "job-batch")).toBe(1);
  });
});
