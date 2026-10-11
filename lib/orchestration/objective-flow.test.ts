import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { normalizeObjectiveIntake } from "@/lib/domain/objective-inbox";
import type { Objective } from "@/lib/domain/objectives";
import { assembleContext } from "@/lib/intelligence/context";
import { advanceObjectiveAcceptedToContextReady, createObjectiveContextSnapshot, createObjectiveOrchestrationRun, objectiveOrchestrationId, objectiveOrchestrationStartIdempotencyKey } from "./objective-flow";
import type { OrchestrationContextSnapshot } from "./owner-intent-flow";

const scope = { userId: "owner-1", portfolioId: "portfolio-1", companyId: "company-1", environment: "staging" as const };
const timestamp = "2026-10-10T12:00:00.000Z";
const objective: Objective = { id: "objective-1", scopeId: scope.companyId, metric: "uptime", direction: "increase", target: 99, priority: 1, status: "active" };
const policy = { scope: { portfolioId: scope.portfolioId, companyId: scope.companyId, allowedSensitivity: ["public" as const] } };
const runFor = (value = objective) => createObjectiveOrchestrationRun({ objective: value, scope, createdAt: timestamp });
function fixture() {
  let saved: OrchestrationContextSnapshot | null = null;
  const snapshots = {
    get: async () => saved, getByRunVersion: vi.fn(async () => saved),
    create: vi.fn(async (snapshot: OrchestrationContextSnapshot) => { saved = snapshot; return { status: "created" as const, snapshot }; })
  };
  return { run: runFor(), objectives: { get: vi.fn(async (): Promise<typeof objective | null> => objective) },
    candidates: { listForObjective: vi.fn(async () => []) }, policy: { resolve: vi.fn(async () => policy) }, snapshots,
    now: () => new Date(timestamp) };
}
function rehash(snapshot: OrchestrationContextSnapshot, patch: Partial<OrchestrationContextSnapshot>) {
  const base = { ...snapshot, ...patch };
  delete (base as Partial<OrchestrationContextSnapshot>).snapshotHash;
  return { ...base, snapshotHash: sha256Hex(base) };
}
describe("authoritative objective context", () => {
  it("uses stable objective identity and rejects blank identities", () => {
    expect(objectiveOrchestrationId(objective.id)).toBe(runFor().id);
    expect(objectiveOrchestrationStartIdempotencyKey(objective.id)).toContain(objective.id);
    for (const derive of [objectiveOrchestrationId, objectiveOrchestrationStartIdempotencyKey]) expect(() => derive(" ")).toThrow("Objective id is required");
    expect(createObjectiveOrchestrationRun({ objective, scope, correlationId: " supplied ", createdAt: timestamp }).correlationId).toBe("supplied");
  });
  it.each(["paused", "completed"] as const)("rejects %s objectives", status => {
    expect(() => runFor({ ...objective, status })).toThrow("runnable");
  });
  it("allows portfolio objectives, but rejects foreign scope", () => {
    expect(runFor({ ...objective, scopeId: scope.portfolioId }).scope).toEqual(scope);
    expect(() => runFor({ ...objective, scopeId: "foreign" })).toThrow("scope");
  });
  it.each(["portfolioId", "companyId", "environment", "createdByUserId"] as const)("checks inbox objective %s against trusted authority", key => {
    const [original] = normalizeObjectiveIntake({ rawText: "Improve uptime" }, { scope, correlationId: "c", now: timestamp, nextId: () => "inbox-1" });
    expect(() => createObjectiveOrchestrationRun({ objective: { ...original, [key]: "foreign" }, scope, createdAt: timestamp })).toThrow("scope");
  });
  it.each(["queued", "planning", "executing", "new_work_required"] as const)("freezes %s inbox objectives with immutable constraints", status => {
    const [original] = normalizeObjectiveIntake({ rawText: "Improve uptime" }, { scope, correlationId: "c", now: timestamp, nextId: () => "inbox-1" });
    const record = { ...original, status };
    const run = createObjectiveOrchestrationRun({ objective: record, scope, createdAt: timestamp });
    const snapshot = createObjectiveContextSnapshot({ run, objective: record, assembledContext: assembleContext([], policy.scope), createdAt: timestamp });
    expect(snapshot.sourceInput).toMatchObject({ type: "objective", normalizedGoal: record.normalizedGoal, constraints: record.constraints });
    expect(Object.isFrozen(snapshot.sourceInput)).toBe(true);
    expect(Object.isFrozen(snapshot.assembledContext)).toBe(true);
  });
  it("persists context once and reuses it after a crash before run advancement", async () => {
    const input = fixture();
    const first = await advanceObjectiveAcceptedToContextReady(input);
    const replay = await advanceObjectiveAcceptedToContextReady(input);
    expect(first).toMatchObject({ kind: "advance", next: { state: "context-ready", version: 2 } });
    expect(replay).toEqual(first);
    expect(input.snapshots.create).toHaveBeenCalledOnce();
    expect(input.candidates.listForObjective).toHaveBeenCalledOnce();
    const snapshot = (await input.snapshots.get())!;
    expect(snapshot.sourceInput).toMatchObject({ metric: "uptime", target: 99 });
    expect(snapshot.sourceHash).toBe(sha256Hex(objective));
  });
  it("refuses missing or changed authoritative objectives before any context reads", async () => {
    const input = fixture();
    input.objectives.get.mockResolvedValueOnce(null);
    await expect(advanceObjectiveAcceptedToContextReady(input)).rejects.toThrow("missing authoritative");
    input.objectives.get.mockResolvedValueOnce({ ...objective, target: 100 });
    await expect(advanceObjectiveAcceptedToContextReady(input)).rejects.toThrow("lineage");
    expect(input.candidates.listForObjective).not.toHaveBeenCalled();
  });
  it("rejects the wrong orchestration state and source", async () => {
    const input = fixture();
    await expect(advanceObjectiveAcceptedToContextReady({ ...input, run: { ...input.run, state: "context-ready" } })).rejects.toThrow("accepted");
    await expect(advanceObjectiveAcceptedToContextReady({ ...input, run: { ...input.run, source: { ...input.run.source, type: "owner-intent" } } })).rejects.toThrow("Objective");
    expect(() => createObjectiveContextSnapshot({ run: { ...input.run, state: "context-ready" }, objective, assembledContext: assembleContext([], policy.scope), createdAt: timestamp })).toThrow("accepted");
  });
  it.each(["portfolioId", "companyId"] as const)("rejects broadened context %s", async key => {
    const input = fixture();
    input.policy.resolve.mockResolvedValue({ scope: { ...policy.scope, [key]: "foreign" } });
    await expect(advanceObjectiveAcceptedToContextReady(input)).rejects.toThrow("broaden");
    expect(input.snapshots.create).not.toHaveBeenCalled();
  });
  it.each(["sourceId", "sourceHash", "portfolioId", "companyId"] as const)("rejects a validly hashed replay for a different %s", async key => {
    const input = fixture();
    await advanceObjectiveAcceptedToContextReady(input);
    const snapshot = rehash((await input.snapshots.get())!, { [key]: key === "sourceHash" ? "a".repeat(64) : "foreign" });
    input.snapshots.getByRunVersion.mockResolvedValue(snapshot);
    await expect(advanceObjectiveAcceptedToContextReady(input)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("rejects storage returning a different authoritative source", async () => {
    const input = fixture();
    input.snapshots.create.mockImplementation(async snapshot => ({ status: "created", snapshot: rehash(snapshot, { sourceHash: "b".repeat(64) }) }));
    await expect(advanceObjectiveAcceptedToContextReady(input)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
