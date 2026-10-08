import { describe, expect, it, vi } from "vitest";
import { AuthoritativeExecutionCoordinator } from "@/lib/orchestration/authoritative-execution-coordinator";

const outcome = { kind: "failed", code: "TEST", reason: "test" } as const;
const fns = vi.hoisted(() => ({
  owner: vi.fn(async () => outcome),
  objective: vi.fn(async () => outcome),
  context: vi.fn(async () => outcome),
  planner: vi.fn(async () => outcome),
  validation: vi.fn(async () => outcome),
  policy: vi.fn(async () => outcome),
  authorization: vi.fn(async () => outcome),
  decision: vi.fn(async () => outcome),
  tasks: vi.fn(async () => outcome),
  jobs: vi.fn(async () => outcome),
  executing: vi.fn(() => outcome),
  verification: vi.fn(async () => outcome),
  completion: vi.fn(async () => outcome)
}));

vi.mock("@/lib/orchestration/owner-intent-flow", () => ({
  advanceOwnerIntentAcceptedToContextReady: fns.owner
}));
vi.mock("@/lib/orchestration/objective-flow", () => ({
  advanceObjectiveAcceptedToContextReady: fns.objective
}));
vi.mock("@/lib/orchestration/planning-flow", () => ({
  advanceContextReadyToPlanning: fns.context,
  advancePlanningToPlanned: fns.planner
}));
vi.mock("@/lib/orchestration/validation-policy-flow", () => ({
  advancePlannedToValidated: fns.validation,
  advanceValidatedToPolicyEvaluated: fns.policy
}));
vi.mock("@/lib/orchestration/authorization-flow", () => ({
  advancePolicyEvaluatedToAuthority: fns.authorization,
  advanceAwaitingDecisionToAuthorized: fns.decision
}));
vi.mock("@/lib/orchestration/post-authorization-flow", () => ({
  advanceAuthorizedToTasksCreated: fns.tasks,
  advanceTasksCreatedToJobsEnqueued: fns.jobs,
  advanceJobsEnqueuedToExecuting: fns.executing,
  advanceExecutingToVerifying: fns.verification,
  advanceVerifyingToCompleted: fns.completion
}));

const deps = {
  ownerIntentContext: {}, objectiveContext: {}, contextPlanning: {}, planner: {},
  validation: {}, policy: {}, authorization: {}, decisionResume: {}, taskDag: {},
  jobs: {}, execution: {}, completion: {}
} as any;

function run(state: string, sourceType = "owner-intent") {
  return {
    id: "run-1", state, version: 1, recordHash: "hash", correlationId: "corr-1",
    source: { type: sourceType, id: "source-1", sourceHash: "source-hash" },
    scope: { userId: "owner", portfolioId: "portfolio", companyId: "company", environment: "staging" }
  } as any;
}

describe("AuthoritativeExecutionCoordinator routing", () => {
  it.each([
    ["context-ready", "context"], ["planning", "planner"], ["planned", "validation"],
    ["validated", "policy"], ["policy-evaluated", "authorization"],
    ["awaiting-decision", "decision"], ["authorized", "tasks"],
    ["tasks-created", "jobs"], ["jobs-enqueued", "executing"],
    ["executing", "verification"], ["verifying", "completion"]
  ])("routes %s through the single authoritative handler", async (state, fn) => {
    const coordinator = new AuthoritativeExecutionCoordinator(deps);
    await expect(coordinator.execute({ run: run(state) } as any)).resolves.toEqual(outcome);
    expect((fns as any)[fn]).toHaveBeenCalled();
  });

  it("routes accepted owner intent and objective through source-specific context materialization", async () => {
    const coordinator = new AuthoritativeExecutionCoordinator(deps);
    await coordinator.execute({ run: run("accepted", "owner-intent") } as any);
    await coordinator.execute({ run: run("accepted", "objective") } as any);
    expect(fns.owner).toHaveBeenCalled();
    expect(fns.objective).toHaveBeenCalled();
  });

  it("fails closed for accepted sources without a trusted context adapter", async () => {
    const coordinator = new AuthoritativeExecutionCoordinator(deps);
    await expect(coordinator.execute({ run: run("accepted", "signal") } as any))
      .resolves.toMatchObject({ kind: "failed", code: "SOURCE_CONTEXT_NOT_MATERIALIZED" });
  });

  it.each(["blocked", "failed", "cancelled", "completed"])(
    "refuses to execute terminal state %s",
    async (state) => {
      const coordinator = new AuthoritativeExecutionCoordinator(deps);
      await expect(coordinator.execute({ run: run(state) } as any)).rejects.toMatchObject({
        code: "CONFLICT"
      });
    }
  );

  it("advertises a coordination-only, PostgreSQL-authoritative boundary", () => {
    expect(new AuthoritativeExecutionCoordinator(deps).descriptor).toEqual({
      path: "owner-intent/objective->verified-outcome",
      providerAccess: false,
      authorityCreation: false,
      uiAuthority: false,
      authoritativePersistence: "postgresql"
    });
  });
});
