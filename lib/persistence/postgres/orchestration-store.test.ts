import { describe, expect, it } from "vitest";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import type { PostgresTransactionalDatabase, SqlQueryable } from "@/lib/persistence/postgres/client";
import {
  buildOwnerIntentOrchestrationRun,
  persistOwnerIntentOrchestrationTrigger,
  PostgresOrchestrationRuntimeStore
} from "@/lib/persistence/postgres/orchestration-store";
import type {
  ClaimedOrchestrationRun,
  OrchestrationQueueEvent,
  OrchestrationRun
} from "@/lib/orchestration/contracts";

interface FakeResponse {
  rows?: QueryResultRow[];
  rowCount?: number;
}

class QueueSql implements SqlQueryable {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  constructor(private readonly responses: FakeResponse[] = []) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    const response = this.responses.shift() ?? { rows: [], rowCount: 1 };
    return {
      command: "",
      rowCount: response.rowCount ?? response.rows?.length ?? 0,
      oid: 0,
      fields: [],
      rows: (response.rows ?? []) as R[]
    };
  }
}

function database(sql: QueueSql): PostgresTransactionalDatabase {
  return {
    query: sql.query.bind(sql),
    async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
      return operation(sql as unknown as PoolClient);
    }
  };
}

function runRow(
  overrides: Partial<Record<string, unknown>> = {}
): QueryResultRow {
  return {
    id: "orchestration:owner-intent:intent-1",
    correlation_id: "corr-1",
    portfolio_id: "portfolio-1",
    company_id: "company-1",
    environment: "staging",
    authority_user_id: "user-1",
    initiating_actor_type: "user",
    initiating_actor_id: "user-1",
    source_kind: "owner-intent",
    source_id: "intent-1",
    source_payload: { kind: "owner-intent", ownerIntentId: "intent-1" },
    state: "received",
    attempt: 1,
    version: 1,
    available_at: "2026-09-27T20:00:00.000Z",
    lease_owner: null,
    lease_expires_at: null,
    last_error_code: null,
    last_error_message: null,
    created_at: "2026-09-27T20:00:00.000Z",
    updated_at: "2026-09-27T20:00:00.000Z",
    ...overrides
  };
}

function queueRow(
  overrides: Partial<Record<string, unknown>> = {}
): QueryResultRow {
  return {
    id: "outbox:orchestration.triggered:orchestration:owner-intent:intent-1",
    correlation_id: "corr-1",
    portfolio_id: "portfolio-1",
    company_id: "company-1",
    event_type: "orchestration.triggered",
    run_id: "orchestration:owner-intent:intent-1",
    occurred_at: "2026-09-27T20:00:00.000Z",
    available_at: "2026-09-27T20:00:00.000Z",
    claimed_by: null,
    claimed_until: null,
    delivered_at: null,
    attempts: 0,
    last_error: null,
    ...overrides
  };
}

function claimed(): ClaimedOrchestrationRun {
  const run: OrchestrationRun = Object.freeze({
    id: "orchestration:owner-intent:intent-1",
    correlationId: "corr-1",
    portfolioId: "portfolio-1",
    companyId: "company-1",
    environment: "staging",
    authorityUserId: "user-1",
    initiatingActor: Object.freeze({ type: "user", id: "user-1" }),
    source: Object.freeze({ kind: "owner-intent", ownerIntentId: "intent-1" }),
    state: "received",
    attempt: 1,
    version: 1,
    availableAt: "2026-09-27T20:00:00.000Z",
    leaseOwner: "worker-1",
    leaseExpiresAt: "2026-09-27T20:00:30.000Z",
    createdAt: "2026-09-27T20:00:00.000Z",
    updatedAt: "2026-09-27T20:00:00.000Z"
  });
  const event: OrchestrationQueueEvent = Object.freeze({
    id: "outbox:orchestration.triggered:orchestration:owner-intent:intent-1",
    correlationId: run.correlationId,
    portfolioId: run.portfolioId,
    companyId: run.companyId,
    eventType: "orchestration.triggered",
    runId: run.id,
    occurredAt: run.createdAt,
    availableAt: run.availableAt,
    claimedBy: "worker-1",
    claimedUntil: run.leaseExpiresAt,
    attempts: 1
  });
  return Object.freeze({ run, event });
}

describe("Postgres orchestration store", () => {
  it("builds deterministic OwnerIntent orchestration authority without copying the message", () => {
    const record: OwnerIntentRecord = Object.freeze({
      id: "intent-1",
      correlationId: "corr-1",
      portfolioId: "portfolio-1",
      companyId: "company-1",
      environment: "staging",
      userId: "user-1",
      message: "Sensitive owner instruction that must stay in owner_intents.",
      channel: "chat",
      status: "accepted",
      receivedAt: "2026-09-27T20:00:00.000Z"
    });

    const run = buildOwnerIntentOrchestrationRun(record);
    expect(run).toMatchObject({
      id: "orchestration:owner-intent:intent-1",
      correlationId: "corr-1",
      portfolioId: "portfolio-1",
      companyId: "company-1",
      state: "received",
      source: { kind: "owner-intent", ownerIntentId: "intent-1" }
    });
    expect(JSON.stringify(run)).not.toContain(record.message);
  });

  it("persists one run and a routing-only trigger event", async () => {
    const sql = new QueueSql([
      { rows: [runRow()], rowCount: 1 },
      { rowCount: 1 }
    ]);
    const record: OwnerIntentRecord = Object.freeze({
      id: "intent-1",
      correlationId: "corr-1",
      portfolioId: "portfolio-1",
      companyId: "company-1",
      environment: "staging",
      userId: "user-1",
      message: "Do the safe work.",
      channel: "chat",
      status: "accepted",
      receivedAt: "2026-09-27T20:00:00.000Z"
    });

    const result = await persistOwnerIntentOrchestrationTrigger(sql, record);
    expect(result.created).toBe(true);
    expect(result.eventId).toContain("orchestration.triggered");
    expect(sql.calls).toHaveLength(2);
    expect(sql.calls[0]?.text).toContain("INSERT INTO orchestration_runs");
    expect(sql.calls[1]?.text).toContain("INSERT INTO orchestration_outbox");
    expect(sql.calls[1]?.values).not.toContain(record.message);
  });

  it("rejects a conflicting pre-existing source authority envelope", async () => {
    const sql = new QueueSql([
      { rows: [], rowCount: 0 },
      {
        rows: [runRow({ correlation_id: "different-correlation" })],
        rowCount: 1
      }
    ]);
    const record: OwnerIntentRecord = Object.freeze({
      id: "intent-1",
      correlationId: "corr-1",
      portfolioId: "portfolio-1",
      companyId: "company-1",
      environment: "staging",
      userId: "user-1",
      message: "Do the safe work.",
      channel: "chat",
      status: "accepted",
      receivedAt: "2026-09-27T20:00:00.000Z"
    });

    await expect(
      persistOwnerIntentOrchestrationTrigger(sql, record)
    ).rejects.toThrow(/different orchestration authority envelope/i);
  });

  it("claims an eligible routing event and tenant run with a worker lease", async () => {
    const sql = new QueueSql([
      { rows: [queueRow()], rowCount: 1 },
      {
        rows: [queueRow({
          claimed_by: "worker-1",
          claimed_until: "2026-09-27T20:00:30.000Z",
          attempts: 1
        })],
        rowCount: 1
      },
      { rows: [runRow()], rowCount: 1 },
      {
        rows: [runRow({
          lease_owner: "worker-1",
          lease_expires_at: "2026-09-27T20:00:30.000Z"
        })],
        rowCount: 1
      }
    ]);
    const store = new PostgresOrchestrationRuntimeStore(database(sql));

    await expect(store.claimNext({
      workerId: "worker-1",
      leaseMilliseconds: 30_000,
      now: "2026-09-27T20:00:00.000Z"
    })).resolves.toMatchObject({
      event: { claimedBy: "worker-1", attempts: 1 },
      run: { leaseOwner: "worker-1", state: "received" }
    });
    expect(sql.calls.some((call) => call.text.includes("FOR UPDATE SKIP LOCKED"))).toBe(true);
  });

  it("moves a busy run's routing event to the authoritative lease expiry", async () => {
    const sql = new QueueSql([
      { rows: [queueRow()], rowCount: 1 },
      {
        rows: [queueRow({
          claimed_by: "worker-2",
          claimed_until: "2026-09-27T20:00:30.000Z",
          attempts: 1
        })],
        rowCount: 1
      },
      {
        rows: [runRow({
          lease_owner: "worker-1",
          lease_expires_at: "2026-09-27T20:00:45.000Z"
        })],
        rowCount: 1
      },
      { rowCount: 1 }
    ]);
    const store = new PostgresOrchestrationRuntimeStore(database(sql));

    await expect(store.claimNext({
      workerId: "worker-2",
      leaseMilliseconds: 30_000,
      now: "2026-09-27T20:00:00.000Z"
    })).resolves.toBeNull();

    const release = sql.calls.at(-1);
    expect(release?.text).toContain("claimed_by=$2");
    expect(release?.values).toEqual([
      queueRow().id,
      "worker-2",
      "2026-09-27T20:00:45.000Z",
      null
    ]);
  });

  it("marks stale routing events delivered when the authoritative run is terminal", async () => {
    const sql = new QueueSql([
      { rows: [queueRow()], rowCount: 1 },
      {
        rows: [queueRow({
          claimed_by: "worker-1",
          claimed_until: "2026-09-27T20:00:30.000Z",
          attempts: 1
        })],
        rowCount: 1
      },
      { rows: [runRow({ state: "succeeded" })], rowCount: 1 },
      { rowCount: 1 }
    ]);
    const store = new PostgresOrchestrationRuntimeStore(database(sql));

    await expect(store.claimNext({
      workerId: "worker-1",
      leaseMilliseconds: 30_000,
      now: "2026-09-27T20:00:00.000Z"
    })).resolves.toBeNull();
    expect(sql.calls.at(-1)?.text).toContain("delivered_at=$3");
  });

  it("transitions under the exact worker lease, emits one resume event, and audits lineage", async () => {
    const current = claimed();
    const sql = new QueueSql([
      {
        rows: [runRow({
          lease_owner: "worker-1",
          lease_expires_at: "2026-09-27T20:00:30.000Z"
        })],
        rowCount: 1
      },
      {
        rows: [runRow({
          state: "context-building",
          version: 2,
          available_at: "2026-09-27T20:00:05.000Z",
          lease_owner: null,
          lease_expires_at: null,
          updated_at: "2026-09-27T20:00:05.000Z"
        })],
        rowCount: 1
      },
      { rowCount: 1 },
      { rowCount: 1 },
      {
        rows: [{ chain_sequence: 1, event_hash: "a".repeat(64) }],
        rowCount: 1
      }
    ]);
    const store = new PostgresOrchestrationRuntimeStore(database(sql));

    await expect(store.transition({
      claim: current,
      workerId: "worker-1",
      nextState: "context-building",
      availableAt: "2026-09-27T20:00:05.000Z",
      scheduleResume: true,
      now: "2026-09-27T20:00:05.000Z"
    })).resolves.toMatchObject({
      state: "context-building",
      version: 2,
      leaseOwner: undefined
    });

    expect(sql.calls.some((call) => call.text.includes("'orchestration.resume'"))).toBe(true);
    expect(sql.calls.at(-1)?.text).toContain("getdone_append_audit_event");
  });

  it("defers without advancing the authority version and releases only its own queue claim", async () => {
    const sql = new QueueSql([{ rowCount: 1 }, { rowCount: 1 }]);
    const store = new PostgresOrchestrationRuntimeStore(database(sql));

    await expect(store.defer({
      claim: claimed(),
      workerId: "worker-1",
      retryAt: "2026-09-27T20:01:00.000Z",
      reason: "planner not configured",
      now: "2026-09-27T20:00:05.000Z"
    })).resolves.toBeUndefined();

    expect(sql.calls[0]?.text).toContain("version=$5");
    expect(sql.calls[1]?.text).toContain("claimed_by=$4");
  });

  it("validates worker ids and lease bounds before touching PostgreSQL", async () => {
    const sql = new QueueSql();
    const store = new PostgresOrchestrationRuntimeStore(database(sql));

    await expect(store.claimNext({
      workerId: "bad worker id",
      leaseMilliseconds: 30_000,
      now: "2026-09-27T20:00:00.000Z"
    })).rejects.toThrow(/worker id/i);
    await expect(store.claimNext({
      workerId: "worker-1",
      leaseMilliseconds: 999,
      now: "2026-09-27T20:00:00.000Z"
    })).rejects.toThrow(/lease/i);
    expect(sql.calls).toHaveLength(0);
  });
});
