import { afterEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { PostgresAuditLedger, PostgresVerificationReceiptStore } from "@/lib/persistence/postgres/authority-stores";
import { createVerificationEvidence } from "@/lib/verification/verification";
import { createJobGraphArtifact, type OrchestrationJobNode } from "./post-authorization-flow";
import { PostgresObjectiveOutcomePort } from "./objective-outcome-runtime.server";
import { executionFixture } from "./test-fixture";

// SQL is the boundary here; the evaluator, hashes, and verification verdict remain real.
class OutcomeDb {
  calls: { sql: string; values: readonly unknown[] }[] = [];
  outputs: unknown[] = [];
  existing: unknown[] = [];
  conflictTable?: string;
  prior: unknown[] = [];
  async query(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes("AS evaluation")) return { rows: this.existing, rowCount: this.existing.length } as never;
    if (sql.includes("FROM business_action_executions")) return { rows: this.outputs.map(output => ({ payload: { output } })), rowCount: this.outputs.length } as never;
    if (sql.trim().startsWith("SELECT")) return { rows: this.prior, rowCount: this.prior.length } as never;
    return { rows: [], rowCount: this.conflictTable && sql.includes(`INSERT INTO ${this.conflictTable}(`) ? 0 : 1 } as never;
  }
  transaction<T>(fn: (client: PoolClient) => Promise<T>) { return fn(this as unknown as PoolClient); }
}
async function fixture(metric = "jobs.verified", target: number | string = 1) {
  const built = await executionFixture();
  const task = built.taskDag.tasks[0];
  const base = { id: "job-1", runId: built.run.id, nodeId: "node-1", taskId: task.id, capability: "repository.inspect", capabilityInput: {}, dependsOnJobIds: [], authorizationGrantId: task.authorizationGrantId,
    authorizationGrantHash: task.authorizationGrantHash, authorizationConsumptionHash: task.authorizationConsumption.consumptionHash,
    state: "verified" as const, verificationReceiptId: "receipt-job", verificationReceiptHash: sha256Hex("receipt"), createdAt: built.now().toISOString(), updatedAt: built.now().toISOString() };
  const job: OrchestrationJobNode = { ...base, nodeHash: sha256Hex(base) };
  const jobGraph = createJobGraphArtifact({ ...built, jobs: [job], createdAt: built.now().toISOString() });
  const evidence = createVerificationEvidence({ id: "evidence-1", portfolioId: built.run.scope.portfolioId, companyId: built.run.scope.companyId, subject: { type: "job", id: job.id }, strategy: "system", result: "pass", sourceType: "system-probe", sourceId: "probe-1", independenceKey: "probe-1", observedAt: built.now().toISOString(), payloadHash: sha256Hex("output"), provenance: "test:verified-worker-output" });
  const db = new OutcomeDb();
  const audit = vi.spyOn(PostgresAuditLedger.prototype, "append").mockResolvedValue(undefined);
  const receipts = vi.spyOn(PostgresVerificationReceiptStore.prototype, "insert").mockResolvedValue(undefined);
  const port = new PostgresObjectiveOutcomePort(db, built.now);
  return { db, port, audit, receipts, input: { ...built, plan: { ...built.plan, proposal: { ...built.plan.proposal, objective: { id: "objective-1", metric, target } } }, jobGraph, evidence: [evidence], idempotencyKey: "evaluate-1" } };
}
afterEach(() => vi.restoreAllMocks());
describe("PostgreSQL objective outcome boundary", () => {
  it("requires an idempotency key and verified worker evidence before querying", async () => {
    const { port, db, input } = await fixture();
    await expect(port.evaluateAndRecord({ ...input, idempotencyKey: " " })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await port.evaluateAndRecord({ ...input, evidence: [] })).toMatchObject({ kind: "pending" });
    expect(await port.evaluateAndRecord({ ...input, jobGraph: { ...input.jobGraph, jobs: [{ ...input.jobGraph.jobs[0], state: "enqueued" }] } })).toMatchObject({ kind: "pending" });
    expect(db.calls).toHaveLength(0);
  });
  it.each(["verified-jobs-completed", "jobs.verified", "execution.verified_jobs", "verified-tasks-completed", "tasks.verified", "execution.verified_tasks", "execution.task_count", "execution.completed"])("records %s from verified work with a receipt and audit", async metric => {
    const { port, db, input, receipts, audit } = await fixture(metric, metric === "execution.completed" ? "true" : 1);
    const result = await port.evaluateAndRecord(input);
    expect(result).toMatchObject({ kind: "verified", evaluation: { status: "met", observations: [{ metric, met: true, evidenceIds: ["evidence-1"] }] }, outcome: { state: "verified" } });
    expect(receipts).toHaveBeenCalledWith(expect.objectContaining({ verdict: "verified" }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "outcome.verified", entityId: `outcome:${input.run.id}` }));
    const ownerWrite = db.calls.find(call => call.sql.includes("INSERT INTO control_plane_entities"))!;
    expect(JSON.parse(String(ownerWrite.values[5]))).toMatchObject({ portfolioId: input.run.scope.portfolioId, companyId: input.run.scope.companyId, metric, state: "verified" });
    expect(db.calls.find(call => call.sql.includes("FROM business_action_executions"))?.values).toEqual([["job-1"]]);
  });
  it.each([{ score: 5 }, { metrics: { score: 5 } }, { score: false, metrics: { score: 5 } }, { score: "5" }])("uses observable provider values with strict numeric targets: %j", async output => {
    const { port, db, input } = await fixture("score", 5);
    db.outputs = [undefined, [], null, output];
    const result = await port.evaluateAndRecord(input);
    expect(result.kind).toBe(typeof output.score === "boolean" || typeof output.score === "string" ? "failed" : "verified");
  });
  it.each([undefined, null, [], {}, { score: Infinity }, { metrics: [] }, { metrics: { score: {} } }])("keeps unobservable metrics pending: %j", async output => {
    const { port, db, input, audit } = await fixture("score", 1);
    db.outputs = [output];
    expect(await port.evaluateAndRecord(input)).toMatchObject({ kind: "pending", reason: expect.stringContaining("not yet observable") });
    expect(db.calls.some(call => call.sql.includes("INSERT"))).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });
  it("uses expected outcomes when no single objective exists", async () => {
    const { port, db, input } = await fixture();
    db.outputs = [{ "inspection-complete": true }];
    const proposal = { ...input.plan.proposal, objective: undefined, expectedOutcomes: [{ metric: "inspection-complete", target: "true", description: "inspection" }] };
    expect(await port.evaluateAndRecord({ ...input, plan: { ...input.plan, proposal } })).toMatchObject({ kind: "verified", evaluation: { observations: [{ observed: true, met: true }] } });
  });
  it("persists a not-met evaluation without recording success or an audit", async () => {
    const { port, db, input, audit, receipts } = await fixture("jobs.verified", 2);
    expect(await port.evaluateAndRecord(input)).toMatchObject({ kind: "failed", code: "OBJECTIVE_NOT_MET" });
    expect(db.calls.filter(call => call.sql.includes("INSERT"))).toHaveLength(1);
    expect(audit).not.toHaveBeenCalled(); expect(receipts).not.toHaveBeenCalled();
  });
  it("replays an intact outcome without issuing new writes", async () => {
    const { port, db, input } = await fixture();
    const result = await port.evaluateAndRecord(input);
    if (result.kind !== "verified") throw new Error("Expected verified fixture");
    db.existing = [{ evaluation: result.evaluation, outcome: result.outcome }];
    db.calls = [];
    expect(await port.evaluateAndRecord(input)).toEqual(result);
    expect(db.calls).toHaveLength(1);
    db.existing = [{ evaluation: { ...result.evaluation, status: "not-met" }, outcome: result.outcome }];
    await expect(port.evaluateAndRecord(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    db.existing = [{ evaluation: result.evaluation, outcome: { ...result.outcome, runId: "foreign" } }];
    await expect(port.evaluateAndRecord(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it.each(["orchestration_objective_evaluations", "orchestration_outcomes", "control_plane_entities"])("fails closed on conflicting %s writes", async table => {
    const { port, db, input } = await fixture();
    db.conflictTable = table;
    await expect(port.evaluateAndRecord(input)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("accepts identical evaluation and outcome conflicts after a concurrent writer", async () => {
    const { port, db, input } = await fixture();
    const result = await port.evaluateAndRecord(input);
    if (result.kind !== "verified") throw new Error("Expected verified fixture");
    db.conflictTable = "orchestration_objective_evaluations";
    db.prior = [{ evaluation_hash: result.evaluation.evaluationHash, payload: result.evaluation }];
    expect((await port.evaluateAndRecord(input)).kind).toBe("verified");
    db.conflictTable = "orchestration_outcomes";
    db.prior = [{ outcome_hash: result.outcome.outcomeHash, payload: result.outcome }];
    expect((await port.evaluateAndRecord(input)).kind).toBe("verified");
  });
});
