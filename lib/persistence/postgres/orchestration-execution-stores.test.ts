import { afterEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { PostgresAuthorizationGrantStore } from "./authority-stores";
import { PostgresOrchestrationTaskDagStore, PostgresOrchestrationJobGraphStore, PostgresOrchestrationTaskDedupeStore } from "./orchestration-execution-stores";
import { createJobGraphArtifact, type OrchestrationJobNode } from "@/lib/orchestration/post-authorization-flow";
import { executionFixture } from "@/lib/orchestration/test-fixture";
class SequenceDb {
  calls: { sql: string; values: readonly unknown[] }[] = [];
  responses: { rows: unknown[]; rowCount: number }[] = [];
  async query(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    const result = this.responses.shift();
    if (!result) throw new Error(`Unexpected SQL: ${sql}`);
    return result as never;
  }
  transaction<T>(fn: (client: PoolClient) => Promise<T>) { return fn(this as unknown as PoolClient); }
}
const empty = () => ({ rows: [], rowCount: 0 });
const inserted = () => ({ rows: [], rowCount: 1 });
const row = (payload: unknown) => ({ rows: [{ payload }], rowCount: 1 });
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const built = await executionFixture();
  const task = built.taskDag.tasks[0];
  const base = { id: "job-1", runId: built.run.id, nodeId: "node-1", taskId: task.id, capability: "repository.inspect", capabilityInput: {}, dependsOnJobIds: [], authorizationGrantId: task.authorizationGrantId, authorizationGrantHash: task.authorizationGrantHash, authorizationConsumptionHash: task.authorizationConsumption.consumptionHash, state: "created" as const, createdAt: built.now().toISOString(), updatedAt: built.now().toISOString() };
  const job: OrchestrationJobNode = { ...base, nodeHash: sha256Hex(base) };
  const graph = createJobGraphArtifact({ ...built, jobs: [job], createdAt: built.now().toISOString() });
  return { ...built, task, job, graph, db: new SequenceDb() };
}
describe("durable task and graph persistence", () => {
  it("persists a task only with its exact grant consumption, then replays intact materialization", async () => {
    const { db, run, task } = await fixture();
    const consume = vi.spyOn(PostgresAuthorizationGrantStore.prototype, "consume").mockResolvedValue(undefined);
    const store = new PostgresOrchestrationTaskDedupeStore(db, run.id);
    db.responses.push(empty(), inserted());
    expect(await store.claim(task, task.authorizationConsumption)).toMatchObject({ created: true, task });
    expect(consume).toHaveBeenCalledWith(task.authorizationConsumption);
    expect(db.calls[0].sql).toContain("FOR UPDATE");
    expect(db.calls[0].values).toEqual([run.id, task.logicalKey]);
    const prior = { payload: task, task_hash: sha256Hex(task), authorization_consumption_hash: task.authorizationConsumption.consumptionHash };
    db.responses.push({ rows: [prior], rowCount: 1 });
    expect(await store.claim(task, task.authorizationConsumption)).toMatchObject({ created: false, task });
    expect(consume).toHaveBeenCalledOnce();
    for (const corrupt of [{ ...prior, task_hash: "wrong" }, { ...prior, authorization_consumption_hash: "wrong" }]) {
      db.responses.push({ rows: [corrupt], rowCount: 1 });
      await expect(store.claim(task, task.authorizationConsumption)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
  it.each(["consumerType", "consumerId", "grantId", "grantHash", "consumptionHash"] as const)("rejects mismatched consumption %s before consuming authority", async key => {
    const { db, task, run } = await fixture(); db.responses.push(empty());
    const consume = vi.spyOn(PostgresAuthorizationGrantStore.prototype, "consume");
    await expect(new PostgresOrchestrationTaskDedupeStore(db, run.id).claim(task, { ...task.authorizationConsumption, [key]: "foreign" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(consume).not.toHaveBeenCalled();
  });
  it("round trips DAGs by id/run and permits only identical conflict replays", async () => {
    const { db, taskDag } = await fixture(); const store = new PostgresOrchestrationTaskDagStore(db);
    db.responses.push(inserted(), row(taskDag), row(taskDag), empty(), row(taskDag), empty(), empty());
    expect(await store.create(taskDag, "create")).toEqual({ status: "created", artifact: taskDag });
    expect(await store.get(taskDag.id)).toEqual(taskDag);
    expect(await store.getByRunId(taskDag.runId)).toEqual(taskDag);
    expect(await store.create(taskDag, "replay")).toEqual({ status: "idempotent-replay", artifact: taskDag });
    await expect(store.create(taskDag, "conflict")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(store.create(taskDag, " ")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(store.create({ ...taskDag, artifactHash: "invalid" }, "hash")).rejects.toMatchObject({ code: "FORBIDDEN" });
    db.responses.push(empty(), empty());
    expect(await store.get("missing")).toBeNull(); expect(await store.getByRunId("missing")).toBeNull();
  });
  it("inserts the graph and nodes together with authorization and tenant lineage", async () => {
    const { db, graph, job } = await fixture(); const store = new PostgresOrchestrationJobGraphStore(db);
    db.responses.push(inserted(), inserted());
    expect(await store.create(graph, "create")).toEqual({ status: "created", artifact: graph });
    expect(db.calls[1].values.slice(0, 9)).toEqual([job.id, graph.runId, job.nodeId, job.taskId, graph.portfolioId, graph.companyId, job.capability, "created", job.nodeHash]);
    db.responses.push(empty(), row(graph), empty(), row({ ...graph, artifactHash: "different" }));
    expect((await store.create(graph, "replay")).status).toBe("idempotent-replay");
    await expect(store.create(graph, "conflict")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(store.create(graph, "")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(store.create({ ...graph, artifactHash: "bad" }, "create")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("uses state CAS and refreshes graph hashes after node transitions", async () => {
    const { db, graph, job } = await fixture(); const store = new PostgresOrchestrationJobGraphStore(db);
    const next = { ...job, state: "verified" as const, verificationRequestId: "request", verificationReceiptId: "receipt", verificationReceiptHash: sha256Hex("receipt") };
    db.responses.push(inserted(), row(graph), row(next), inserted());
    const result = await store.updateNode({ job: next, expectedState: "created" });
    const { nodeHash, ...base } = result;
    expect(nodeHash).toBe(sha256Hex(base));
    expect(db.calls[0].values.slice(0, 7)).toEqual([job.id, job.runId, "created", "verified", "request", "receipt", next.verificationReceiptHash]);
    expect(db.calls[0].sql).toContain("AND state=$3");
    const persisted = JSON.parse(String(db.calls[3].values[2]));
    const { artifactHash, ...graphBase } = persisted;
    expect(artifactHash).toBe(sha256Hex(graphBase));
    expect(persisted.jobs).toEqual([next]);
  });
  it("accepts same-state CAS replay, rejects divergent or missing state, and detects a missing graph", async () => {
    const { db, job } = await fixture(); const store = new PostgresOrchestrationJobGraphStore(db);
    db.responses.push(empty(), row(job));
    expect(await store.updateNode({ job, expectedState: "created" })).toEqual(job);
    db.responses.push(empty(), row({ ...job, state: "failed" }));
    await expect(store.updateNode({ job, expectedState: "created" })).rejects.toMatchObject({ code: "CONFLICT" });
    db.responses.push(empty(), empty());
    await expect(store.updateNode({ job, expectedState: "created" })).rejects.toMatchObject({ code: "CONFLICT" });
    db.responses.push(inserted(), empty());
    await expect(store.updateNode({ job, expectedState: "created" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
