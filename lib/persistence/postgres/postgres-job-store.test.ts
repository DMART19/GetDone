import { describe, expect, it } from "vitest";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  createDurableJobLease,
  createJobQueueEnvelope,
  createJobRetryScheduleRecord,
  createDeadLetterRecord,
  createJobStoreTransactionReceipt,
  type DurableJobLease
} from "@/lib/execution/job-runtime-contracts";
import { PostgresDurableJobStore } from "@/lib/persistence/postgres/job-store";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

interface ResponseSpec {
  rows?: QueryResultRow[];
  rowCount?: number;
}

class ScriptedDb implements PostgresTransactionalDatabase {
  readonly calls: string[] = [];
  constructor(readonly responses: ResponseSpec[]) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string
  ): Promise<QueryResult<R>> {
    this.calls.push(text.replace(/\s+/g, " ").trim());
    const response = this.responses.shift() ?? { rows: [], rowCount: 1 };
    return {
      command: "",
      rowCount: response.rowCount ?? response.rows?.length ?? 0,
      oid: 0,
      fields: [],
      rows: (response.rows ?? []) as R[]
    };
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
    return operation(this as unknown as PoolClient);
  }
}

const envelope = createJobQueueEnvelope({
  id: "queue-1",
  jobId: "job-1",
  taskId: "task-1",
  scope: {
    userId: "owner",
    portfolioId: "portfolio",
    companyId: "company",
    environment: "staging"
  },
  authorizationConsumptionHash: "authorization-consumption",
  idempotencyKey: "enqueue-key",
  scheduledAt: "2026-09-21T04:00:00Z",
  createdAt: "2026-09-21T03:59:00Z"
});

function runtimeRow(
  state: "queued" | "claimed" | "retry-wait" | "dead-lettered" | "cancelled" | "released" = "queued",
  version = 1,
  stateHash = "runtime-hash",
  attempt = 0
) {
  return {
    job_id: envelope.jobId,
    envelope,
    envelope_hash: envelope.envelopeHash,
    runtime_state: state,
    version,
    state_hash: stateHash,
    attempt,
    scheduled_at: "2026-09-21T04:00:00Z",
    cancelled_reason: null,
    updated_at: "2026-09-21T04:00:00Z"
  };
}

function lease(attempt = 1): DurableJobLease {
  return createDurableJobLease({
    id: `lease-${attempt}`,
    jobId: envelope.jobId,
    workerId: "worker-a",
    attempt,
    leaseIssuedAt: "2026-09-21T04:00:01Z",
    leaseSeconds: 60
  });
}

describe("PostgresDurableJobStore", () => {
  it("discovers ready candidates and returns runtime snapshots", async () => {
    const row = runtimeRow();
    const db = new ScriptedDb([{ rows: [row] }, { rows: [row] }]);
    const store = new PostgresDurableJobStore(db);
    expect(await store.listReady({ now: "2026-09-21T04:00:02Z", limit: 500 }))
      .toEqual([{ envelope, version: 1, stateHash: "runtime-hash", attempt: 0 }]);
    expect(await store.getRuntimeSnapshot(envelope.jobId)).toMatchObject({
      state: "queued",
      scheduledAt: "2026-09-21T04:00:00Z"
    });
    expect(store.descriptor.productionEligible).toBe(true);
  });

  it("enqueues a new durable Job and persists transaction lineage", async () => {
    const db = new ScriptedDb([
      { rows: [] },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    const store = new PostgresDurableJobStore(db);
    const result = await store.enqueue(envelope);
    expect(result.status).toBe("enqueued");
    expect(result.transaction.operation).toBe("enqueue");
    expect(db.calls.some((call) => call.includes("INSERT INTO job_runtime_state"))).toBe(true);
    expect(db.calls.some((call) => call.includes("INSERT INTO job_runtime_transactions"))).toBe(true);
  });

  it("returns an idempotent enqueue replay for the same envelope", async () => {
    const receipt = createJobStoreTransactionReceipt({
      id: "tx-enqueue",
      operation: "enqueue",
      jobId: envelope.jobId,
      idempotencyKey: envelope.idempotencyKey,
      expectedVersion: 0,
      expectedHash: "absent",
      nextVersion: 1,
      nextHash: "queued",
      occurredAt: envelope.createdAt
    });
    const db = new ScriptedDb([
      { rows: [runtimeRow()] },
      { rows: [{ payload: receipt }] }
    ]);
    const result = await new PostgresDurableJobStore(db).enqueue(envelope);
    expect(result).toEqual({ status: "idempotent-replay", transaction: receipt });
  });

  it("claims queued work with a durable lease and CAS receipt", async () => {
    const db = new ScriptedDb([
      { rows: [runtimeRow()] },
      { rows: [] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    const store = new PostgresDurableJobStore(db);
    const result = await store.claimAtomic({
      jobId: envelope.jobId,
      workerId: "worker-a",
      now: "2026-09-21T04:00:01Z",
      leaseSeconds: 60,
      expectedJobVersion: 1,
      expectedJobHash: "runtime-hash",
      idempotencyKey: "claim-1"
    });
    expect(result?.lease).toMatchObject({ jobId: "job-1", workerId: "worker-a", attempt: 1 });
    expect(result?.transaction.operation).toBe("claim");
  });

  it("returns null when claim CAS or readiness is stale", async () => {
    const db = new ScriptedDb([{ rows: [runtimeRow("released")] }]);
    const result = await new PostgresDurableJobStore(db).claimAtomic({
      jobId: envelope.jobId,
      workerId: "worker-a",
      now: "2026-09-21T04:00:01Z",
      leaseSeconds: 60,
      expectedJobVersion: 1,
      expectedJobHash: "runtime-hash",
      idempotencyKey: "claim-1"
    });
    expect(result).toBeNull();
  });

  it("renews a matching active lease and advances runtime CAS", async () => {
    const active = lease();
    const db = new ScriptedDb([
      { rows: [runtimeRow("claimed", 2, "claimed-hash", 1)] },
      { rows: [{ payload: active }] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    const result = await new PostgresDurableJobStore(db).heartbeat({
      lease: active,
      now: "2026-09-21T04:00:10Z",
      extendSeconds: 60,
      expectedJobVersion: 2,
      expectedJobHash: "claimed-hash",
      idempotencyKey: "heartbeat-1"
    });
    expect(result.lease.version).toBe(2);
    expect(result.transaction.operation).toBe("heartbeat");
  });

  it("releases a claimed Job and closes its lease with a new hash", async () => {
    const active = lease();
    const db = new ScriptedDb([
      { rows: [runtimeRow("claimed", 2, "claimed-hash", 1)] },
      { rows: [{ payload: active }] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    const receipt = await new PostgresDurableJobStore(db).release({
      lease: active,
      now: "2026-09-21T04:00:15Z",
      expectedJobVersion: 2,
      expectedJobHash: "claimed-hash",
      idempotencyKey: "release-1"
    });
    expect(receipt.operation).toBe("release");
    expect(db.calls.some((call) => call.includes("runtime_state='released'"))).toBe(true);
  });

  it("schedules retry and closes an active lease atomically", async () => {
    const active = lease();
    const retry = createJobRetryScheduleRecord({
      id: "retry-1",
      jobId: envelope.jobId,
      nextAttempt: 2,
      runAt: "2026-09-21T04:01:00Z",
      reason: "transient",
      sourceEnvelopeHash: envelope.envelopeHash,
      transactionHash: "prior-tx"
    });
    const db = new ScriptedDb([
      { rows: [runtimeRow("claimed", 2, "claimed-hash", 1)] },
      { rowCount: 1 },
      { rows: [{ payload: active }] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    const receipt = await new PostgresDurableJobStore(db).scheduleRetry(retry);
    expect(receipt.operation).toBe("retry");
    expect(db.calls.some((call) => call.includes("state='released'"))).toBe(true);
  });

  it("dead-letters and cancels while closing active leases", async () => {
    const active = lease();
    const dead = createDeadLetterRecord({
      id: "dead-1",
      jobId: envelope.jobId,
      finalAttempt: 3,
      reason: "terminal",
      failedAt: "2026-09-21T04:02:00Z",
      sourceEnvelopeHash: envelope.envelopeHash,
      transactionHash: "prior"
    });
    const deadDb = new ScriptedDb([
      { rows: [runtimeRow("claimed", 3, "claimed-hash", 3)] },
      { rowCount: 1 },
      { rows: [{ payload: active }] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    expect((await new PostgresDurableJobStore(deadDb).deadLetter(dead)).operation)
      .toBe("dead-letter");

    const cancelDb = new ScriptedDb([
      { rows: [runtimeRow("claimed", 3, "claimed-hash", 3)] },
      { rowCount: 1 },
      { rows: [{ payload: active }] },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    expect((await new PostgresDurableJobStore(cancelDb).cancel({
      jobId: envelope.jobId,
      reason: "owner",
      cancelledAt: "2026-09-21T04:02:00Z",
      expectedJobVersion: 3,
      expectedJobHash: "claimed-hash",
      idempotencyKey: "cancel-1"
    })).operation).toBe("cancel");
  });

  it("recovers an expired lease into retry state and records recovery lineage", async () => {
    const active = lease(1);
    const db = new ScriptedDb([
      { rows: [{ ...runtimeRow("claimed", 2, "claimed-hash", 1), lease_payload: active }] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    const store = new PostgresDurableJobStore(db, { maxAttempts: 5, recoveryDelayMs: 5000 });
    const recovered = await store.recoverExpired({ now: "2026-09-21T04:02:00Z", limit: 10 });
    expect(recovered).toHaveLength(1);
    expect(recovered[0].outcome).toBe("retry-scheduled");
    expect(db.calls.some((call) => call.includes("SKIP LOCKED"))).toBe(true);
    expect(db.calls.some((call) => call.includes("INSERT INTO job_recovery_records"))).toBe(true);
  });

  it("recovers an exhausted expired lease into dead letter", async () => {
    const active = lease(5);
    const db = new ScriptedDb([
      { rows: [{ ...runtimeRow("claimed", 8, "claimed-hash", 5), lease_payload: active }] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    const recovered = await new PostgresDurableJobStore(db, { maxAttempts: 5 })
      .recoverExpired({ now: "2026-09-21T04:02:00Z", limit: 10 });
    expect(recovered[0].outcome).toBe("dead-lettered");
    expect(db.calls.some((call) => call.includes("INSERT INTO job_dead_letters"))).toBe(true);
  });
});
