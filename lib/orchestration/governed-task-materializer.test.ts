import { describe, expect, it, vi } from "vitest";
import type { AuthorizationConsumptionRecord } from "@/lib/authorization/grants";
import type { TaskRecord } from "@/lib/domain/services/task-service";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import type { OrchestrationExecutionArtifactStore } from "@/lib/orchestration/execution-artifact-store";
import {
  createAuthorizationBundleExecutionArtifact,
  createValidationReceiptExecutionArtifact,
  type OrchestrationExecutionArtifact,
  type OrchestrationExecutionArtifactKind
} from "@/lib/orchestration/execution-artifacts";
import { GovernedTaskMaterializer } from "@/lib/orchestration/governed-task-materializer";
import type { OrchestrationPlanningArtifactStore } from "@/lib/orchestration/planning-artifact-store";
import {
  createGovernedPlanArtifact,
  type OrchestrationPlanningArtifactKind
} from "@/lib/orchestration/planning-artifacts";
import type { GeneratedTask, TaskGenerationDedupeStore } from "@/lib/planning/task-generator";
import { hashPlan } from "@/lib/planning/plan-hash";
import { validPlan } from "@/lib/planning/test-fixture";
import { autoGrantFor, fixtureNow, receiptFor } from "@/lib/planning/test-security-fixture";

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
    state: "authorized",
    attempt: 1,
    version: 7,
    availableAt: fixtureNow.toISOString(),
    createdAt: fixtureNow.toISOString(),
    updatedAt: fixtureNow.toISOString()
  });
}

class MemoryDedupe implements TaskGenerationDedupeStore {
  task?: GeneratedTask;
  consumption?: AuthorizationConsumptionRecord;
  async claim(task: GeneratedTask, consumption: AuthorizationConsumptionRecord) {
    if (this.task) {
      return { created: false, task: this.task, consumption: this.consumption! };
    }
    this.task = task;
    this.consumption = consumption;
    return { created: true, task, consumption };
  }
}

describe("GovernedTaskMaterializer", () => {
  it("generates, authorizes, and compiles Tasks from exact grants without queueing Jobs", async () => {
    const plan = validPlan();
    const planHash = hashPlan(plan);
    const receipt = receiptFor(plan);
    const grant = autoGrantFor(plan, plan.steps[0].id, receipt);
    const planArtifact = createGovernedPlanArtifact({
      id: "plan-artifact-1",
      runId: run().id,
      correlationId: run().correlationId,
      contextSnapshotId: "context-1",
      contextHash: "c".repeat(64),
      plan,
      planHash,
      aiAudit: { auditHash: "a".repeat(64) } as never,
      route: { decisionHash: "d".repeat(64) } as never,
      plannedAt: fixtureNow.toISOString()
    });
    const receiptArtifact = createValidationReceiptExecutionArtifact({
      id: "receipt-artifact-1",
      runId: run().id,
      correlationId: run().correlationId,
      planHash,
      receipt,
      createdAt: fixtureNow.toISOString()
    });
    const authorization = createAuthorizationBundleExecutionArtifact({
      id: "authorization-artifact-1",
      runId: run().id,
      correlationId: run().correlationId,
      planHash,
      validationReceiptId: receipt.id,
      validationReceiptHash: receipt.receiptHash,
      grants: [grant],
      createdAt: fixtureNow.toISOString()
    });

    const appended: OrchestrationExecutionArtifact[] = [];
    const execution: OrchestrationExecutionArtifactStore = {
      append: async (_run, artifact) => {
        appended.push(artifact);
        return { created: true };
      },
      latestValidationReceipt: async () => receiptArtifact,
      latestAuthorizationBundle: async () => authorization,
      latestTaskDag: async () => null,
      latestJobBatch: async () => null,
      count: async (_run, kind: OrchestrationExecutionArtifactKind) =>
        appended.filter((item) => item.kind === kind).length
    };
    const planning: OrchestrationPlanningArtifactStore = {
      append: async () => ({ created: true }),
      latestContext: async () => null,
      latestPlan: async () => planArtifact,
      latestValidation: async () => null,
      latestPolicy: async () => null,
      count: async (_run, _kind: OrchestrationPlanningArtifactKind) => 0
    };

    const records = new Map<string, TaskRecord>();
    const create = vi.fn(async (input: {
      id: string;
      reason: string;
      evidenceIds?: readonly string[];
      capabilityRequirements: readonly string[];
      dependencyTaskIds?: readonly string[];
      createdAt?: string;
    }) => {
      const record = {
        id: input.id,
        portfolioId: "portfolio-a",
        companyId: "company-a",
        state: "proposed",
        reason: input.reason,
        evidenceIds: input.evidenceIds ?? [],
        capabilityRequirements: input.capabilityRequirements,
        dependencyTaskIds: input.dependencyTaskIds ?? [],
        authorizationLineage: [],
        verificationEvidenceIds: [],
        version: 1,
        updatedAt: input.createdAt ?? fixtureNow.toISOString()
      } as TaskRecord;
      records.set(record.id, record);
      return record;
    });
    const authorize = vi.fn(async (
      id: string,
      _command: unknown,
      passedGrant: typeof grant,
      consumedAt: string
    ) => {
      const current = records.get(id)!;
      const task = (new MemoryDedupe()).task;
      void task;
      const generated = dedupe.task!;
      const record = {
        ...current,
        state: "authorized",
        version: current.version + 1,
        authorizationLineage: [passedGrant.id],
        authorizationGrantId: passedGrant.id,
        authorizationGrantHash: passedGrant.grantHash,
        authorizationConsumption: {
          ...generated.authorizationConsumption,
          consumedAt
        }
      } as TaskRecord;
      records.set(id, record);
      return record;
    });

    const dedupe = new MemoryDedupe();
    const materializer = new GovernedTaskMaterializer(
      planning,
      execution,
      dedupe,
      { create, authorize } as never,
      { get: async (id) => records.get(id) ?? null },
      () => fixtureNow
    );

    const result = await materializer.materialize(run());

    expect(create).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(result.tasks).toHaveLength(1);
    expect(result.dag.nodes.length).toBeGreaterThan(0);
    expect(result.tasks[0]?.authorizationGrantHash).toBe(grant.grantHash);
    expect(await execution.count(run(), "task-dag")).toBe(1);
  });
});
