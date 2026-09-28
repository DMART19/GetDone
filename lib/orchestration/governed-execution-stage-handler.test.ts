import { describe, expect, it, vi } from "vitest";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import { GovernedExecutionStageHandler } from "@/lib/orchestration/governed-execution-stage-handler";

function run(state: OrchestrationRun["state"]): OrchestrationRun {
  return Object.freeze({
    id: "run-1",
    correlationId: "corr-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging",
    authorityUserId: "user-a",
    initiatingActor: Object.freeze({ type: "user" as const, id: "user-a" }),
    source: Object.freeze({ kind: "owner-intent" as const, ownerIntentId: "intent-1" }),
    state,
    attempt: 1,
    version: 7,
    availableAt: "2026-09-27T21:00:00.000Z",
    createdAt: "2026-09-27T20:00:00.000Z",
    updatedAt: "2026-09-27T21:00:00.000Z"
  });
}

function handler(input: {
  authorizationResult?: unknown;
  enqueued?: number;
} = {}) {
  const ensure = vi.fn(async () => []);
  const authorize = vi.fn(async () => input.authorizationResult ?? ({
    kind: "authorized" as const,
    grants: []
  }));
  const materializeTasks = vi.fn(async () => ({ id: "task-dag-1" }));
  const materializeJobs = vi.fn(async () => ({
    id: "job-batch-1",
    enqueued: Array.from({ length: input.enqueued ?? 1 }, (_, index) => ({
      jobId: `job-${index + 1}`
    }))
  }));
  const instance = new GovernedExecutionStageHandler(
    {
      latestPlan: async () => ({
        id: "plan-artifact",
        runId: "run-1",
        correlationId: "corr-1",
        contextSnapshotId: "context",
        contextHash: "c".repeat(64),
        plan: {} as never,
        planHash: "p".repeat(64),
        aiAudit: { auditHash: "a".repeat(64) } as never,
        aiAuditHash: "a".repeat(64),
        route: { decisionHash: "d".repeat(64) } as never,
        routeDecisionHash: "d".repeat(64),
        authorityApplied: false,
        plannedAt: "2026-09-27T20:00:00.000Z",
        artifactHash: "bad-but-mocked" 
      }),
      latestPolicy: async () => ({
        id: "policy-artifact",
        runId: "run-1",
        correlationId: "corr-1",
        planArtifactId: "plan-artifact",
        planHash: "p".repeat(64),
        validationArtifactId: "validation",
        validationAttestationHash: "v".repeat(64),
        strongestDisposition: "APPROVAL_REQUIRED",
        ownerDecisionRequired: false,
        stepPolicies: [],
        authorityApplied: false,
        createdAt: "2026-09-27T20:00:00.000Z",
        bundleHash: "bad-but-mocked"
      })
    } as never,
    { ensure } as never,
    { authorize } as never,
    { materialize: materializeTasks } as never,
    { materializeAndEnqueue: materializeJobs } as never,
    () => new Date("2026-09-27T21:00:00.000Z")
  );
  return { instance, ensure, authorize, materializeTasks, materializeJobs };
}

describe("GovernedExecutionStageHandler", () => {
  it("waits safely for owner approval and retries without advancing authority", async () => {
    const { instance, authorize } = handler({
      authorizationResult: {
        kind: "awaiting-approval",
        reason: "approval-pending:step-1"
      }
    });

    // Avoid plan/policy integrity in this focused routing test by using policy-cleared
    // for authorization result behavior; awaiting-approval integrity is covered in the
    // materializer/authorization tests.
    await expect(instance.advance(run("policy-cleared"))).resolves.toMatchObject({
      kind: "defer",
      reason: "approval-pending:step-1"
    });
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("moves exact persisted grants into authorized and schedules Task materialization", async () => {
    const { instance } = handler();
    await expect(instance.advance(run("policy-cleared"))).resolves.toMatchObject({
      kind: "transition",
      state: "authorized",
      wake: "immediate"
    });
  });

  it("materializes the authorized Task DAG before entering Job materialization", async () => {
    const { instance, materializeTasks } = handler();
    await expect(instance.advance(run("authorized"))).resolves.toMatchObject({
      kind: "transition",
      state: "materializing",
      wake: "immediate"
    });
    expect(materializeTasks).toHaveBeenCalledTimes(1);
  });

  it("stops at queued after Job materialization and never invokes a provider", async () => {
    const { instance, materializeJobs } = handler({ enqueued: 2 });
    await expect(instance.advance(run("materializing"))).resolves.toMatchObject({
      kind: "transition",
      state: "queued",
      wake: "external",
      reason: "job-batch-materialized:roots-enqueued=2"
    });
    expect(materializeJobs).toHaveBeenCalledTimes(1);
  });

  it("does not advance queued work into provider execution in this tranche", async () => {
    const { instance } = handler();
    await expect(instance.advance(run("queued"))).resolves.toMatchObject({
      kind: "defer",
      reason: "provider-execution-is-outside-current-tranche:queued"
    });
  });
});
