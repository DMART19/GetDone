import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createJobQueueEnvelope } from "@/lib/execution/job-runtime-contracts";
import { DurableJobWorker } from "@/lib/execution/job-worker-runtime";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresDurableJobStore } from "@/lib/persistence/postgres/job-store";
import { PostgresJobWorkerInstanceStore } from "@/lib/persistence/postgres/worker-runtime-stores";
import { PostgresOrchestrationWorkerRegistry } from "@/lib/persistence/postgres/orchestration-worker-registry";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";
import { PostgresIdempotencyStore } from "@/lib/persistence/postgres/authority-stores";

const url = process.env.GETDONE_AUTH_BOUNDARY_TEST_DATABASE_URL ?? "";
let allowed = false;
try {
  const parsed = new URL(url);
  allowed = process.env.GETDONE_AUTH_BOUNDARY_INTEGRATION === "true"
    && ["127.0.0.1", "localhost"].includes(parsed.hostname)
    && /^getdone_auth_test_[a-z0-9_]+$/.test(parsed.pathname.slice(1));
} catch { /* fail closed outside disposable CI */ }

(allowed ? describe : describe.skip)("real tenant-scoped job and worker RLS", () => {
  const seed = randomUUID().replaceAll("-", "");
  const now = "2026-10-17T04:30:00.000Z";
  const scopeA = {
    userId: "owner-a-" + seed, portfolioId: "portfolio-a-" + seed,
    companyId: "company-a-" + seed, environment: "staging" as const
  };
  const scopeB = {
    userId: "owner-b-" + seed, portfolioId: "portfolio-b-" + seed,
    companyId: "company-b-" + seed, environment: "staging" as const
  };
  const administration = new Pool({ connectionString: url, ssl: false, max: 2 });
  const tenant = new PostgresDatabase({
    connectionString: url, ssl: false, runtimeRole: "getdone_tenant_runtime"
  });
  const registry = new PostgresDatabase({
    connectionString: url, ssl: false, runtimeRole: "getdone_worker_registry"
  });
  const dispatch = new PostgresDatabase({
    connectionString: url, ssl: false, runtimeRole: "getdone_job_dispatch"
  });
  const store = new PostgresDurableJobStore(tenant, {}, dispatch);
  const withScope = <T>(scope: typeof scopeA, action: () => Promise<T>) =>
    runWithPostgresTenantScope(scope, action);
  const envelope = (jobId: string, scope: typeof scopeA) => createJobQueueEnvelope({
    id: "queue:" + jobId, jobId, taskId: "task:" + jobId,
    scope, authorizationConsumptionHash: "fake-test-consumption-" + jobId,
    idempotencyKey: "enqueue:" + jobId, scheduledAt: now, createdAt: now
  });
  const jobA = "job-a-" + seed;
  const jobB = "job-b-" + seed;
  const jobRecovery = "job-recover-" + seed;

  afterAll(async () => {
    await Promise.all([tenant.close(), registry.close(), dispatch.close(), administration.end()]);
  });

  it("restricts worker service roles to registry heartbeat or minimal discovery", async () => {
    const instances = new PostgresJobWorkerInstanceStore(registry);
    await instances.upsert({
      workerId: "worker-" + seed, processRole: "job-worker",
      status: "starting", startedAt: now, updatedAt: now
    });
    expect((await instances.get("worker-" + seed))?.status).toBe("starting");
    await instances.upsert({
      workerId: "worker-" + seed, processRole: "job-worker",
      status: "running", startedAt: now, updatedAt: now
    });
    expect((await instances.get("worker-" + seed))?.status).toBe("running");

    const orchestration = new PostgresOrchestrationWorkerRegistry(registry);
    await orchestration.start({workerId: "orchestrator-" + seed, processVersion: "test", startedAt: now});
    await orchestration.heartbeat({
      workerId: "orchestrator-" + seed, status: "running",
      heartbeatAt: now, ready: true
    });
    await orchestration.stop({
      workerId: "orchestrator-" + seed, status: "stopped", stoppedAt: now
    });

    await expect(registry.query("SELECT * FROM auth_users")).rejects.toMatchObject({ code: "42501" });
    await expect(registry.query("SELECT * FROM job_runtime_state")).rejects.toMatchObject({ code: "42501" });
    await expect(dispatch.query("SELECT * FROM job_runtime_state")).rejects.toMatchObject({ code: "42501" });
    await expect(dispatch.query("SELECT * FROM auth_users")).rejects.toMatchObject({ code: "42501" });
    await expect(tenant.query("SELECT * FROM job_worker_instances")).rejects.toMatchObject({ code: "42501" });
  });

  it("enqueues separate tenants, forbids cross-tenant writes, and proves single execution", async () => {
    const itemA = envelope(jobA, scopeA);
    const itemB = envelope(jobB, scopeB);
    expect((await withScope(scopeA, () => store.enqueue(itemA))).status).toBe("enqueued");
    expect((await withScope(scopeB, () => store.enqueue(itemB))).status).toBe("enqueued");
    expect((await withScope(scopeA, () => store.enqueue(itemA))).status).toBe("idempotent-replay");

    expect((await withScope(scopeA, () => store.getRuntimeSnapshot(jobB)))).toBeNull();
    expect((await withScope(scopeB, () => store.getRuntimeSnapshot(jobA)))).toBeNull();

    const pending = await store.listReady({ now: "2026-10-17T04:30:01.000Z", limit: 10 });
    expect(pending.map(job => job.envelope.jobId).sort()).toEqual([jobA, jobB].sort());

    let sideEffects = 0;
    const worker = new DurableJobWorker(store, {
      workerId: "worker-" + seed, leaseSeconds: 30,
      heartbeatSeconds: 5, batchSize: 10, concurrency: 2
    }, () => new Date("2026-10-17T04:30:01.000Z"));
    const result = await worker.runOnce({
      execute: async context => {
        sideEffects++;
        await context.heartbeat();
        return { kind: "verified" };
      }
    });
    expect(result).toHaveLength(2);
    expect(sideEffects).toBe(2);
    expect((await withScope(scopeA, () => store.getRuntimeSnapshot(jobA)))?.state).toBe("released");
    expect((await withScope(scopeB, () => store.getRuntimeSnapshot(jobB)))?.state).toBe("released");
    expect(await worker.runOnce({ execute: async () => {
      sideEffects++;
      return { kind: "verified" };
    }})).toEqual([]);
    expect(sideEffects).toBe(2);
  });

  it("recovers expired leases by tenant without accessing other tenants' runtime rows", async () => {
    const item = envelope(jobRecovery, scopeA);
    await withScope(scopeA, () => store.enqueue(item));
    const state = await withScope(scopeA, () => store.getRuntimeSnapshot(item.jobId));
    expect(state).toBeTruthy();
    const claim = await withScope(scopeA, () => store.claimAtomic({
      jobId: item.jobId, workerId: "crashed-" + seed,
      now: "2026-10-17T04:30:01.000Z", leaseSeconds: 2,
      expectedJobVersion: 1,
      expectedJobHash: state!.stateHash,
      idempotencyKey: "crash:" + seed
    }));
    expect(claim).toBeTruthy();
    const recovered = await store.recoverExpired({
      now: "2026-10-17T04:30:05.000Z", limit: 5
    });
    expect(recovered.map(x => x.jobId)).toContain(jobRecovery);
    expect(recovered.find(x => x.jobId === jobRecovery)?.outcome).toBe("retry-scheduled");
  });

  it("requires tenant scope for idempotency and prevents foreign scope replay", async () => {
    const idempotency = new PostgresIdempotencyStore(tenant);
    const key = "scope:" + seed;
    const claimed = await withScope(scopeA, () => idempotency.claim(key, "fixture-fingerprint", now));
    expect(claimed.state).toBe("CREATED");
    expect((await withScope(scopeB, () => idempotency.get(key)))).toBeNull();
    await withScope(scopeA, () => idempotency.complete(key, "fixture-fingerprint", { ok: true }, now));
    expect((await withScope(scopeA, () => idempotency.get(key)))?.status).toBe("COMPLETED");
    await expect(idempotency.claim("unscoped:" + seed, "fingerprint", now))
      .rejects.toMatchObject({ code: "42501" });
  });
});
