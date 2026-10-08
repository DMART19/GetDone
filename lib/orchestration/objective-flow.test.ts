import { describe, expect, it, vi } from "vitest";
import {
  advanceObjectiveAcceptedToContextReady,
  createObjectiveContextSnapshot,
  createObjectiveOrchestrationRun,
  objectiveOrchestrationId,
  objectiveOrchestrationStartIdempotencyKey
} from "@/lib/orchestration/objective-flow";

const scope = {
  userId: "owner", portfolioId: "portfolio", companyId: "company",
  environment: "staging" as const
};
const objective = {
  id: "objective-1", scopeId: "company", metric: "revenue", direction: "increase" as const,
  target: 100, priority: 1, status: "active" as const
};
const at = "2026-10-05T18:00:00.000Z";

function run() {
  return createObjectiveOrchestrationRun({ objective, scope, createdAt: at });
}
function assembled() {
  return {
    scope: { portfolioId: "portfolio", companyId: "company" },
    items: [], assembledAt: Date.parse(at), expiresAt: Date.parse(at) + 60_000,
    classification: "internal"
  } as any;
}

describe("objective orchestration flow", () => {
  it("derives deterministic identities and rejects blank ids", () => {
    expect(objectiveOrchestrationId("x")).toBe("orchestration:objective:x");
    expect(objectiveOrchestrationStartIdempotencyKey("x")).toBe("orchestration:start:objective:x");
    expect(() => objectiveOrchestrationId(" ")).toThrow(/required/i);
    expect(() => objectiveOrchestrationStartIdempotencyKey(" ")).toThrow(/required/i);
  });

  it("creates a hash-bound accepted run and freezes an objective context snapshot", () => {
    const current = run();
    expect(current).toMatchObject({
      id: "orchestration:objective:objective-1", state: "accepted",
      correlationId: "objective:objective-1", source: { type: "objective", id: "objective-1" }
    });
    const snapshot = createObjectiveContextSnapshot({
      run: current, objective, assembledContext: assembled(), createdAt: at
    });
    expect(snapshot).toMatchObject({
      runId: current.id, runVersion: current.version, sourceType: "objective",
      sourceId: objective.id, sourceInput: { type: "objective", metric: "revenue", target: 100 }
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("rejects paused objectives, cross-tenant scope, and snapshot creation after accepted", () => {
    expect(() => createObjectiveOrchestrationRun({
      objective: { ...objective, status: "paused" }, scope, createdAt: at
    })).toThrow(/runnable/i);
    expect(() => createObjectiveOrchestrationRun({
      objective: { ...objective, scopeId: "other" }, scope, createdAt: at
    })).toThrow(/scope/i);
    const current = { ...run(), state: "context-ready" } as any;
    expect(() => createObjectiveContextSnapshot({
      run: current, objective, assembledContext: assembled(), createdAt: at
    })).toThrow(/accepted/i);
  });

  it("materializes context once and advances to context-ready", async () => {
    const current = run();
    let persisted: any;
    const snapshots = {
      get: vi.fn(async () => null),
      getByRunVersion: vi.fn(async () => null),
      create: vi.fn(async (snapshot: any) => {
        persisted = snapshot;
        return { status: "created" as const, snapshot };
      })
    };
    const result = await advanceObjectiveAcceptedToContextReady({
      run: current,
      objectives: { get: vi.fn(async () => objective) },
      candidates: { listForObjective: vi.fn(async () => []) },
      policy: { resolve: vi.fn(async () => ({
        scope: { portfolioId: "portfolio", companyId: "company" },
        options: { now: Date.parse(at) }
      })) },
      snapshots,
      now: () => new Date(at)
    });
    expect(result).toMatchObject({
      kind: "advance", next: { state: "context-ready", checkpoints: {
        contextSnapshot: { id: persisted.id, hash: persisted.snapshotHash }
      }}
    });
    expect(snapshots.create).toHaveBeenCalledTimes(1);
  });

  it("replays an existing matching snapshot without creating another", async () => {
    const current = run();
    const existing = createObjectiveContextSnapshot({
      run: current, objective, assembledContext: assembled(), createdAt: at
    });
    const create = vi.fn();
    const result = await advanceObjectiveAcceptedToContextReady({
      run: current,
      objectives: { get: vi.fn(async () => objective) },
      candidates: { listForObjective: vi.fn(async () => []) },
      policy: { resolve: vi.fn(async () => ({ scope: { portfolioId: "portfolio", companyId: "company" } })) },
      snapshots: {
        get: vi.fn(async () => existing),
        getByRunVersion: vi.fn(async () => existing),
        create
      },
      now: () => new Date(at)
    });
    expect(result).toMatchObject({ kind: "advance", next: { state: "context-ready" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("fails closed for missing, changed, broadened, or conflicting authoritative context", async () => {
    const current = run();
    const base = {
      run: current,
      candidates: { listForObjective: vi.fn(async () => []) },
      policy: { resolve: vi.fn(async () => ({ scope: { portfolioId: "portfolio", companyId: "company" } })) },
      snapshots: { get: vi.fn(async () => null), getByRunVersion: vi.fn(async () => null), create: vi.fn() },
      now: () => new Date(at)
    };
    await expect(advanceObjectiveAcceptedToContextReady({
      ...base, objectives: { get: vi.fn(async () => null) }
    } as any)).rejects.toThrow(/missing authoritative Objective/i);

    await expect(advanceObjectiveAcceptedToContextReady({
      ...base, objectives: { get: vi.fn(async () => ({ ...objective, target: 101 })) }
    } as any)).rejects.toThrow(/lineage/i);

    await expect(advanceObjectiveAcceptedToContextReady({
      ...base,
      objectives: { get: vi.fn(async () => objective) },
      policy: { resolve: vi.fn(async () => ({ scope: { portfolioId: "other", companyId: "company" } })) }
    } as any)).rejects.toThrow(/broaden/i);

    const existing = createObjectiveContextSnapshot({
      run: current, objective, assembledContext: assembled(), createdAt: at
    });
    await expect(advanceObjectiveAcceptedToContextReady({
      ...base,
      objectives: { get: vi.fn(async () => objective) },
      snapshots: {
        get: vi.fn(async () => null),
        getByRunVersion: vi.fn(async () => ({ ...existing, companyId: "other" })),
        create: vi.fn()
      }
    } as any)).rejects.toThrow();
  });

  it("rejects the wrong stage/source before reading persistence", async () => {
    await expect(advanceObjectiveAcceptedToContextReady({
      run: { ...run(), state: "context-ready" } as any
    } as any)).rejects.toThrow(/accepted Objective/i);
  });
});
