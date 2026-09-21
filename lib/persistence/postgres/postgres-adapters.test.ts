import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { readPostgresConfigFromEnv, type PostgresTransactionalDatabase, type SqlQueryable } from "@/lib/persistence/postgres/client";
import {
  PostgresAuditLedger,
  PostgresEntityStore,
  PostgresIdempotencyStore
} from "@/lib/persistence/postgres/authority-stores";
import { PostgresControlPlaneTransactionManager } from "@/lib/persistence/postgres/transaction-manager";

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

describe("PostgreSQL production persistence adapters", () => {
  it("requires a PostgreSQL DATABASE_URL and keeps credentials server-only", () => {
    expect(() => readPostgresConfigFromEnv({})).toThrow(/DATABASE_URL/);
    expect(() => readPostgresConfigFromEnv({ DATABASE_URL: "https://example.com/db" }))
      .toThrow(/postgres/i);

    const config = readPostgresConfigFromEnv({
      DATABASE_URL: "postgresql://user:pass@db.example.com/getdone",
      GETDONE_DB_POOL_MAX: "12",
      GETDONE_DB_STATEMENT_TIMEOUT_MS: "9000",
      GETDONE_DB_SSL: "true"
    });
    expect(config).toMatchObject({
      maxConnections: 12,
      statementTimeoutMs: 9000,
      ssl: true
    });
  });

  it("defines the required atomic persistence constraints in the migration", () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), "migrations/2026-09-21.1_authority_runtime.sql"),
      "utf8"
    );
    for (const required of [
      "control_plane_entities",
      "idempotency_records",
      "audit_events",
      "authorization_grants",
      "authorization_consumptions",
      "verification_receipts",
      "job_execution_start_facts",
      "job_execution_completion_facts",
      "capacity_ledgers",
      "capacity_reservations",
      "reservation_commits",
      "job_runtime_state",
      "job_leases",
      "job_dead_letters",
      "job_execution_specs",
      "business_action_executions",
      "software_pipeline_records",
      "UNIQUE (grant_id)",
      "job_leases_one_active_per_job"
    ]) {
      expect(sql).toContain(required);
    }
  });

  it("persists authoritative entities with version compare-and-swap", async () => {
    const entity = {
      id: "task-1",
      portfolioId: "portfolio",
      companyId: "company",
      version: 1,
      updatedAt: "2026-09-21T04:00:00Z"
    };
    const sql = new QueueSql([
      { rows: [{ payload: entity }] },
      { rows: [], rowCount: 1 }
    ]);
    const store = new PostgresEntityStore<typeof entity>(sql, "task");
    expect(await store.get(entity.id)).toEqual(entity);
    await store.save({ ...entity, version: 2 }, 1);
    expect(sql.calls[1].text).toContain("AND version=$8");
    await expect(store.save({ ...entity, version: 4 }, 1)).rejects.toThrow(/exactly once/i);
  });

  it("claims idempotency atomically and replays completed state", async () => {
    const row = {
      key: "idem-1",
      fingerprint: "fingerprint",
      status: "IN_PROGRESS",
      created_at: "2026-09-21T04:00:00Z",
      completed_at: null,
      failed_at: null,
      result: null,
      error_code: null
    };
    const sql = new QueueSql([
      { rows: [], rowCount: 1 },
      { rows: [row], rowCount: 1 },
      {
        rows: [{
          ...row,
          status: "COMPLETED",
          completed_at: "2026-09-21T04:00:01Z",
          result: { ok: true }
        }],
        rowCount: 1
      }
    ]);
    const store = new PostgresIdempotencyStore(sql);
    expect((await store.claim("idem-1", "fingerprint", row.created_at)).state).toBe("CREATED");
    expect((await store.complete("idem-1", "fingerprint", { ok: true }, "2026-09-21T04:00:01Z")).result)
      .toEqual({ ok: true });
    expect(sql.calls[1].text).toContain("FOR UPDATE");
  });

  it("writes append-only audit events and reads them in sequence", async () => {
    const event = {
      id: "audit-1",
      correlationId: "correlation-1",
      eventType: "job.claimed",
      actor: { type: "system" as const, id: "worker" },
      scope: {
        userId: "owner",
        portfolioId: "portfolio",
        companyId: "company"
      },
      environment: "staging" as const,
      entityType: "job" as const,
      entityId: "job-1",
      previousState: "queued",
      newState: "claimed",
      occurredAt: "2026-09-21T04:00:00Z",
      provenance: "test",
      metadata: {}
    };
    const sql = new QueueSql([
      { rows: [], rowCount: 1 },
      { rows: [{ payload: event }] }
    ]);
    const ledger = new PostgresAuditLedger(sql);
    await ledger.append(event);
    expect(await ledger.listByCorrelationId(event.correlationId)).toEqual([event]);
    expect(sql.calls[0].text).toContain("INSERT INTO audit_events");
  });

  it("runs stores, audit, and idempotency on the same transaction client", async () => {
    const sql = new QueueSql();
    let transactionCount = 0;
    const db: PostgresTransactionalDatabase = {
      query: sql.query.bind(sql),
      async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
        transactionCount += 1;
        return operation(sql as unknown as PoolClient);
      }
    };
    const manager = new PostgresControlPlaneTransactionManager(db, (client) => ({
      entities: new PostgresEntityStore(client, "job")
    }));
    const result = await manager.run(async (tx) => {
      expect(tx.audit).toBeInstanceOf(PostgresAuditLedger);
      expect(tx.idempotency).toBeInstanceOf(PostgresIdempotencyStore);
      return tx.stores.entities;
    });
    expect(result).toBeInstanceOf(PostgresEntityStore);
    expect(transactionCount).toBe(1);
  });
});
