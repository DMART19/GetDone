import { describe, expect, it, vi } from "vitest";
import {
  OrchestrationCoordinator,
  type OrchestrationRuntimeStore,
  type OrchestrationStageHandler
} from "@/lib/orchestration/coordinator";
import {
  assertOrchestrationTransition,
  type ClaimedOrchestrationRun,
  type OrchestrationRun
} from "@/lib/orchestration/contracts";

function run(state: OrchestrationRun["state"] = "received"): OrchestrationRun {
  return Object.freeze({
    id: "orchestration:owner-intent:intent-1",
    correlationId: "corr-1",
    portfolioId: "portfolio-1",
    companyId: "company-1",
    environment: "staging",
    authorityUserId: "user-1",
    initiatingActor: Object.freeze({ type: "user" as const, id: "user-1" }),
    source: Object.freeze({ kind: "owner-intent" as const, ownerIntentId: "intent-1" }),
    state,
    attempt: 1,
    version: 1,
    availableAt: "2026-09-27T20:00:00.000Z",
    leaseOwner: "orchestration-worker-1",
    leaseExpiresAt: "2026-09-27T20:00:30.000Z",
    createdAt: "2026-09-27T20:00:00.000Z",
    updatedAt: "2026-09-27T20:00:00.000Z"
  });
}

function claim(state: OrchestrationRun["state"] = "received"): ClaimedOrchestrationRun {
  const current = run(state);
  return Object.freeze({
    run: current,
    event: Object.freeze({
      id: "outbox:orchestration.triggered:orchestration:owner-intent:intent-1",
      correlationId: current.correlationId,
      portfolioId: current.portfolioId,
      companyId: current.companyId,
      eventType: "orchestration.triggered" as const,
      runId: current.id,
      occurredAt: current.createdAt,
      availableAt: current.availableAt,
      claimedBy: "orchestration-worker-1",
      claimedUntil: current.leaseExpiresAt,
      attempts: 1
    })
  });
}

function runtimeStore(currentClaim: ClaimedOrchestrationRun | null) {
  const transition = vi.fn(async (input: Parameters<OrchestrationRuntimeStore["transition"]>[0]) =>
    Object.freeze({
      ...input.claim.run,
      state: input.nextState,
      version: input.claim.run.version + 1,
      availableAt: input.availableAt,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: input.now
    })
  );
  const defer = vi.fn(async () => undefined);
  const store: OrchestrationRuntimeStore = {
    claimNext: vi.fn(async () => currentClaim),
    transition,
    defer
  };
  return { store, transition, defer };
}

describe("OrchestrationCoordinator", () => {
  it("advances one durable state at a time and schedules the next stage explicitly", async () => {
    const currentClaim = claim("received");
    const { store, transition } = runtimeStore(currentClaim);
    const handler: OrchestrationStageHandler = {
      advance: vi.fn(async () => ({
        kind: "transition" as const,
        state: "context-building" as const,
        wake: "immediate" as const
      }))
    };
    const coordinator = new OrchestrationCoordinator(
      store,
      handler,
      {
        workerId: "orchestration-worker-1",
        leaseMilliseconds: 30_000,
        errorBackoffMilliseconds: 5_000
      },
      () => new Date("2026-09-27T20:00:05.000Z")
    );

    await expect(coordinator.runOnce()).resolves.toMatchObject({
      outcome: "transitioned",
      previousState: "received",
      state: "context-building",
      wake: "immediate"
    });
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({
      nextState: "context-building",
      scheduleResume: true
    }));
  });

  it("supports an external wake barrier for approval and other authoritative continuations", async () => {
    const currentClaim = claim("policy-evaluation");
    const { store, transition } = runtimeStore(currentClaim);
    const handler: OrchestrationStageHandler = {
      advance: vi.fn(async () => ({
        kind: "transition" as const,
        state: "awaiting-approval" as const,
        wake: "external" as const
      }))
    };
    const coordinator = new OrchestrationCoordinator(
      store,
      handler,
      {
        workerId: "orchestration-worker-1",
        leaseMilliseconds: 30_000,
        errorBackoffMilliseconds: 5_000
      }
    );

    await coordinator.runOnce();
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({
      nextState: "awaiting-approval",
      scheduleResume: false
    }));
  });

  it("permits policy-cleared without treating policy as authorization", async () => {
    const currentClaim = claim("policy-evaluation");
    const { store, transition } = runtimeStore(currentClaim);
    const handler: OrchestrationStageHandler = {
      advance: vi.fn(async () => ({
        kind: "transition" as const,
        state: "policy-cleared" as const,
        wake: "external" as const
      }))
    };
    const coordinator = new OrchestrationCoordinator(
      store,
      handler,
      {
        workerId: "orchestration-worker-1",
        leaseMilliseconds: 30_000,
        errorBackoffMilliseconds: 5_000
      }
    );

    await expect(coordinator.runOnce()).resolves.toMatchObject({
      previousState: "policy-evaluation",
      state: "policy-cleared",
      wake: "external"
    });
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({
      nextState: "policy-cleared",
      scheduleResume: false
    }));
    expect(() => assertOrchestrationTransition("policy-evaluation", "authorized"))
      .toThrow(/invalid orchestration transition/i);
    expect(() => assertOrchestrationTransition("policy-cleared", "authorized"))
      .not.toThrow();
  });

  it("defers without mutating authoritative state when a stage is not ready", async () => {
    const currentClaim = claim("planning");
    const { store, transition, defer } = runtimeStore(currentClaim);
    const handler: OrchestrationStageHandler = {
      advance: vi.fn(async () => ({
        kind: "defer" as const,
        retryAt: "2026-09-27T20:01:00.000Z",
        reason: "planner-not-configured"
      }))
    };
    const coordinator = new OrchestrationCoordinator(
      store,
      handler,
      {
        workerId: "orchestration-worker-1",
        leaseMilliseconds: 30_000,
        errorBackoffMilliseconds: 5_000
      }
    );

    await expect(coordinator.runOnce()).resolves.toMatchObject({
      outcome: "deferred",
      reason: "planner-not-configured"
    });
    expect(transition).not.toHaveBeenCalled();
    expect(defer).toHaveBeenCalledWith(expect.objectContaining({
      retryAt: "2026-09-27T20:01:00.000Z",
      reason: "planner-not-configured"
    }));
  });

  it("fails closed on an invalid stage transition and releases the claim for retry", async () => {
    const currentClaim = claim("received");
    const { store, transition, defer } = runtimeStore(currentClaim);
    const handler: OrchestrationStageHandler = {
      advance: vi.fn(async () => ({
        kind: "transition" as const,
        state: "succeeded" as const,
        wake: "external" as const
      }))
    };
    const coordinator = new OrchestrationCoordinator(
      store,
      handler,
      {
        workerId: "orchestration-worker-1",
        leaseMilliseconds: 30_000,
        errorBackoffMilliseconds: 5_000
      },
      () => new Date("2026-09-27T20:00:05.000Z")
    );

    await expect(coordinator.runOnce()).rejects.toThrow(/Invalid orchestration transition/);
    expect(transition).not.toHaveBeenCalled();
    expect(defer).toHaveBeenCalledTimes(1);
  });
});
