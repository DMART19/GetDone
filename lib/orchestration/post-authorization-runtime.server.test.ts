import { afterEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { PostgresAuditLedger, PostgresEntityStore, PostgresVerificationReceiptStore } from "@/lib/persistence/postgres/authority-stores";
import { PostgresOrchestrationJobGraphStore } from "@/lib/persistence/postgres/orchestration-execution-stores";
import { PostgresJobVerificationEvidenceStore } from "@/lib/persistence/postgres/worker-runtime-stores";
import { JobService, type JobRecord } from "@/lib/domain/services/job-service";
import { createVerificationEvidence, type VerificationEvidence } from "@/lib/verification/verification";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { PostgresGovernedJobRuntime, getPostgresGovernedJobRuntimeFromEnv, resetPostgresGovernedJobRuntimeForTests } from "./post-authorization-runtime.server";
import type { DurableJobGraphArtifact, OrchestrationJobNode } from "./post-authorization-flow";
import { executionFixture } from "./test-fixture";
const worker = vi.hoisted(() => ({ enqueueAuthorizedBusinessAction: vi.fn(), status: vi.fn() }));
vi.mock("@/lib/execution/mvp-job-runtime.server", () => ({ getMvpJobRuntimeFromEnv: () => worker }));
vi.mock("@/lib/execution/durable-job-engine.server", () => ({ getDurableJobEngineFromEnv: () => worker }));

afterEach(() => { vi.restoreAllMocks(); worker.enqueueAuthorizedBusinessAction.mockReset(); worker.status.mockReset(); resetPostgresGovernedJobRuntimeForTests(); });
async function fixture() {
  const built = await executionFixture();
  // Model durable graph updates at the store boundary; dispatch and lifecycle ports are observed.
  let graph: DurableJobGraphArtifact | null = null;
  let nodes: OrchestrationJobNode[] = [];
  let projection: JobRecord | null = null;
  let evidence: VerificationEvidence[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql.includes("SELECT payload FROM control_plane_entities")) return { rows: projection ? [{ payload: projection }] : [], rowCount: projection ? 1 : 0 } as never;
    if (sql.includes("INSERT INTO control_plane_entities")) projection = JSON.parse(String(values[5]));
    return { rows: [], rowCount: 1 } as never;
  });
  const db = { query, transaction: <T>(fn: (client: PoolClient) => Promise<T>) => fn({ query } as unknown as PoolClient) };
  const getGraph = vi.spyOn(PostgresOrchestrationJobGraphStore.prototype, "getByRunId").mockImplementation(async () => graph as DurableJobGraphArtifact);
  vi.spyOn(PostgresOrchestrationJobGraphStore.prototype, "create").mockImplementation(async artifact => { graph = artifact; nodes = [...artifact.jobs]; return { status: "created", artifact }; });
  vi.spyOn(PostgresOrchestrationJobGraphStore.prototype, "listNodes").mockImplementation(async () => nodes);
  const update = vi.spyOn(PostgresOrchestrationJobGraphStore.prototype, "updateNode").mockImplementation(async ({ job, expectedState }) => {
    expect(nodes.find(n => n.id === job.id)?.state).toBe(expectedState);
    nodes = nodes.map(n => n.id === job.id ? job : n);
    graph = { ...graph!, jobs: nodes };
    return job;
  });
  vi.spyOn(PostgresAuditLedger.prototype, "append").mockResolvedValue(undefined);
  const receipt = vi.spyOn(PostgresVerificationReceiptStore.prototype, "insert").mockResolvedValue(undefined);
  vi.spyOn(PostgresJobVerificationEvidenceStore.prototype, "listByJobId").mockImplementation(async () => evidence);
  vi.spyOn(PostgresEntityStore.prototype, "get").mockImplementation(async () => projection);
  const begin = vi.spyOn(JobService.prototype, "beginVerification").mockImplementation(async () => ({ ...projection!, state: "verifying" }));
  const verify = vi.spyOn(JobService.prototype, "verify").mockImplementation(async () => ({ ...projection!, state: "verified" }));
  const fail = vi.spyOn(JobService.prototype, "failVerification").mockImplementation(async () => ({ ...projection!, state: "failed" }));
  worker.status.mockResolvedValue({ outcomes: [] });
  const runtime = new PostgresGovernedJobRuntime(db, {}, built.now);
  const input = { ...built, idempotencyKey: "dispatch-1" };
  const materialize = () => runtime.materializeAndEnqueue(input);
  const reconcile = () => runtime.reconcile({ ...input, jobGraph: graph! });
  return { ...built, input, db, runtime, materialize, reconcile, update, receipt, begin, verify, fail, getGraph,
    nodes: () => nodes, setNodes: (next: OrchestrationJobNode[]) => { nodes = next; },
    setProjection: (next: JobRecord | null) => { projection = next; }, projection: () => projection!,
    setEvidence: (next: VerificationEvidence[]) => { evidence = next; } };
}
function proof(job: OrchestrationJobNode, result: "pass" | "fail" = "pass", patch: Partial<VerificationEvidence> = {}) {
  return createVerificationEvidence({ id: "evidence-1", portfolioId: "portfolio-a", companyId: "company-a", subject: { type: "job", id: job.id }, strategy: "system", result, sourceType: "provider", sourceId: "provider-1", independenceKey: "provider-1", observedAt: job.createdAt, payloadHash: sha256Hex("output"), provenance: "test:worker-result", ...patch });
}
describe("governed job runtime", () => {
  it("materializes exact task authority and replays without dispatching twice", async () => {
    const f = await fixture();
    const graph = await f.materialize();
    expect(graph.jobs).toHaveLength(1);
    expect(graph.jobs[0].state).toBe("enqueued");
    expect(worker.enqueueAuthorizedBusinessAction).toHaveBeenCalledWith(expect.objectContaining({ state: "queued", taskId: f.taskDag.tasks[0].id }), expect.objectContaining({ scope: f.taskDag.tasks[0].scope, capability: "repository.inspect", authorizationConsumptionHash: f.taskDag.tasks[0].authorizationConsumption.consumptionHash, timeoutMs: expect.any(Number) }));
    expect(await f.materialize()).toEqual(graph);
    expect(worker.enqueueAuthorizedBusinessAction).toHaveBeenCalledOnce();
  });
  it("rejects missing capability, missing task, empty DAG and broken dependency lineage", async () => {
    const f = await fixture();
    const node = f.taskDag.dag.nodes.find(n => n.kind === "capability")!;
    for (const nodes of [[], [{ ...node, capability: undefined }], [{ ...node, taskId: "missing" }], [{ ...node, dependsOn: ["missing"] }]]) {
      await expect(f.runtime.materializeAndEnqueue({ ...f.input, taskDag: { ...f.taskDag, dag: { ...f.taskDag.dag, nodes } } })).rejects.toThrow();
    }
    expect(worker.enqueueAuthorizedBusinessAction).not.toHaveBeenCalled();
  });
  it("waits for dependencies before dispatching and rejects cyclic intermediate nodes", async () => {
    const f = await fixture();
    const node = f.taskDag.dag.nodes.find(n => n.kind === "capability")!;
    const barrier = { ...node, id: "barrier", kind: "verification" as const, dependsOn: ["barrier"] };
    await expect(f.runtime.materializeAndEnqueue({ ...f.input, taskDag: { ...f.taskDag, dag: { ...f.taskDag.dag, nodes: [barrier, { ...node, dependsOn: [barrier.id] }] } } })).rejects.toThrow("cycle");
    await f.materialize();
    f.setNodes([{ ...f.nodes()[0], state: "created", dependsOnJobIds: ["waiting-job"] }]);
    await f.materialize();
    expect(worker.enqueueAuthorizedBusinessAction).toHaveBeenCalledOnce();
  });
  it("rejects a task authorization mismatch before dispatch", async () => {
    const f = await fixture(); await f.materialize();
    f.setNodes([{ ...f.nodes()[0], state: "created", authorizationGrantHash: "wrong" }]);
    await expect(f.materialize()).rejects.toThrow("authorization differs");
  });
  it("rejects conflicting job identities but recognizes completed projections on replay", async () => {
    const f = await fixture(); await f.materialize();
    f.setNodes([{ ...f.nodes()[0], state: "created" }]);
    f.setProjection({ ...f.projection(), taskId: "foreign" });
    await expect(f.materialize()).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    f.setProjection({ ...f.projection(), taskId: f.taskDag.tasks[0].id, state: "verified" });
    expect((await f.materialize()).jobs[0].state).toBe("verified");
    expect(worker.enqueueAuthorizedBusinessAction).toHaveBeenCalledOnce();
  });
  it("requires scoped credential leases for credential-bearing tasks", async () => {
    const f = await fixture();
    const taskDag = { ...f.taskDag, tasks: f.taskDag.tasks.map(task => ({ ...task, resourceRequirements: { ...task.resourceRequirements, credentialBindingRequired: true } })) };
    await expect(f.runtime.materializeAndEnqueue({ ...f.input, taskDag })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(worker.enqueueAuthorizedBusinessAction).not.toHaveBeenCalled();
    const resolve = vi.fn(async () => "lease-1");
    await new PostgresGovernedJobRuntime(f.db, {}, f.now, { resolve }).materializeAndEnqueue({ ...f.input, taskDag });
    expect(worker.enqueueAuthorizedBusinessAction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ credentialLeaseId: "lease-1" }));
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ run: f.run, task: taskDag.tasks[0] }));
  });
  it("stays pending until worker completion and durable evidence", async () => {
    const f = await fixture(); await f.materialize();
    expect(await f.reconcile()).toMatchObject({ kind: "pending" });
    worker.status.mockResolvedValue({ outcomes: [{ kind: "retry-scheduled" }] });
    expect(await f.reconcile()).toMatchObject({ kind: "pending" });
    worker.status.mockResolvedValue({ outcomes: [{ kind: "provider-completed" }] });
    expect(await f.reconcile()).toMatchObject({ kind: "pending", reason: expect.stringContaining("not persisted") });
    await expect(f.runtime.reconcile({ ...f.input, jobGraph: await f.materialize(), idempotencyKey: " " })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it.each(["failed", "cancelled"] as const)("propagates terminal node state %s", async state => {
    const f = await fixture(); await f.materialize(); f.setNodes([{ ...f.nodes()[0], state }]);
    expect(await f.reconcile()).toMatchObject({ kind: "failed", code: "JOB_TERMINAL_FAILURE" });
  });
  it.each(["dead-lettered", "cancelled"])("records terminal worker outcome %s", async kind => {
    const f = await fixture(); await f.materialize(); worker.status.mockResolvedValue({ outcomes: [{ kind }] });
    expect(await f.reconcile()).toMatchObject({ kind: "failed", code: "JOB_TERMINAL_FAILURE" });
    expect(f.nodes()[0].state).toBe(kind === "cancelled" ? "cancelled" : "failed");
  });
  it("advances the job through verification, saves receipts and replays verified evidence", async () => {
    const f = await fixture(); await f.materialize();
    f.setProjection({ ...f.projection(), state: "provider_completed" });
    f.setEvidence([proof(f.nodes()[0])]);
    worker.status.mockResolvedValue({ outcomes: [{ kind: "provider-completed" }] });
    expect(await f.reconcile()).toMatchObject({ kind: "verified", verificationRequestIds: [expect.stringContaining("verification:")], evidence: [expect.objectContaining({ result: "pass" })] });
    expect(f.begin).toHaveBeenCalledOnce(); expect(f.verify).toHaveBeenCalledOnce();
    expect(f.receipt).toHaveBeenCalledWith(expect.objectContaining({ verdict: "verified" }));
    expect((await f.reconcile()).kind).toBe("verified");
    expect(f.verify).toHaveBeenCalledOnce();
  });
  it("does not equate a failed capability check with successful execution", async () => {
    const f = await fixture(); await f.materialize(); f.setEvidence([proof(f.nodes()[0], "fail")]);
    worker.status.mockResolvedValue({ outcomes: [{ kind: "provider-completed" }] });
    expect(await f.reconcile()).toMatchObject({ kind: "pending", reason: expect.stringContaining("no passing evidence") });
    expect(f.verify).not.toHaveBeenCalled();
  });
  it("requires independent evidence when requested by the task", async () => {
    const f = await fixture(); await f.materialize(); f.setEvidence([proof(f.nodes()[0])]);
    worker.status.mockResolvedValue({ outcomes: [{ kind: "provider-completed" }] });
    const taskDag = { ...f.taskDag, tasks: f.taskDag.tasks.map(t => ({ ...t, verificationRequirements: [{ id: "independent", kind: "independent-check" as const, required: true, description: "Independent check" }] })) };
    expect(await f.runtime.reconcile({ ...f.input, taskDag, jobGraph: await f.materialize() })).toMatchObject({ kind: "pending", reason: expect.stringContaining("independent") });
  });
  it("fails closed if the graph or job projection disappears", async () => {
    const f = await fixture(); await f.materialize();
    // pg rows are typed as present even when the database returns no rows.
    f.getGraph.mockResolvedValueOnce(null as unknown as DurableJobGraphArtifact);
    await expect(f.reconcile()).rejects.toMatchObject({ code: "NOT_FOUND" });
    f.setEvidence([proof(f.nodes()[0])]); f.setProjection(null);
    worker.status.mockResolvedValue({ outcomes: [{ kind: "verified" }] });
    await expect(f.reconcile()).rejects.toThrow("projection was not found");
  });
  it("rejects verification handoff from an unexpected lifecycle state", async () => {
    const f = await fixture(); await f.materialize(); f.setEvidence([proof(f.nodes()[0])]);
    worker.status.mockResolvedValue({ outcomes: [{ kind: "verified" }] });
    await expect(f.reconcile()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.verify).not.toHaveBeenCalled();
  });
  it("caches and resets the runtime installation", async () => {
    const { db } = await fixture();
    const first = getPostgresGovernedJobRuntimeFromEnv(db, {});
    expect(getPostgresGovernedJobRuntimeFromEnv(db, {})).toBe(first);
    resetPostgresGovernedJobRuntimeForTests();
    expect(getPostgresGovernedJobRuntimeFromEnv(db, {})).not.toBe(first);
  });
});
