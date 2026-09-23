import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresAIGatewayHealthStore } from "@/lib/persistence/postgres/ai-gateway-health-store";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const integrationDescribe = enabled ? describe.sequential : describe.skip;
const baseConnectionString = process.env.DATABASE_URL?.trim() ?? "";
const ssl = process.env.GETDONE_DB_SSL === "false"
  ? false
  : { rejectUnauthorized: true };

function quoteIdentifier(value: string) {
  return '"' + value.replaceAll('"', '""') + '"';
}

function databaseUrl(name: string) {
  const url = new URL(baseConnectionString);
  url.pathname = `/${name}`;
  return url.toString();
}

function migrate(connectionString: string) {
  const result = spawnSync(process.execPath, ["scripts/migrate-postgres.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: connectionString,
      GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false"
    },
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`Migration failed\n${result.stdout}\n${result.stderr}`);
  }
}

integrationDescribe("AI Gateway health PostgreSQL acceptance", () => {
  const databaseName = `getdone_ai_health_${process.pid}_${Date.now()}`;
  const scopeA = {
    userId: "owner-a",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging" as const
  };
  const scopeB = {
    userId: "owner-b",
    portfolioId: "portfolio-b",
    companyId: "company-b",
    environment: "staging" as const
  };

  let admin: Pool;
  let database: PostgresDatabase;
  let connectionString: string;
  let store: PostgresAIGatewayHealthStore;

  beforeAll(async () => {
    if (!baseConnectionString) throw new Error("DATABASE_URL is required");
    admin = new Pool({
      connectionString: baseConnectionString,
      max: 2,
      application_name: "getdone-ai-health-admin",
      ssl
    });
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    connectionString = databaseUrl(databaseName);
    migrate(connectionString);

    database = new PostgresDatabase({
      connectionString,
      maxConnections: 2,
      statementTimeoutMs: 5_000,
      connectionTimeoutMs: 2_000,
      runtimeRole: "getdone_tenant_runtime",
      ssl: process.env.GETDONE_DB_SSL !== "false"
    });
    store = new PostgresAIGatewayHealthStore(database);

    const testDb = new Pool({
      connectionString,
      max: 2,
      application_name: "getdone-ai-health-seed",
      ssl
    });
    try {
      await testDb.query(
        `INSERT INTO ai_call_audits
          (request_id,correlation_id,portfolio_id,company_id,validation_status,
           estimated_cost_cents,actual_cost_cents,audit_hash,payload,recorded_at)
         VALUES
          ('request-a','correlation-a','portfolio-a','company-a','failed',1,0,$1,$2::jsonb,'2026-09-22T20:02:00Z'),
          ('request-b','correlation-b','portfolio-b','company-b','failed',1,0,$3,$4::jsonb,'2026-09-22T20:03:00Z')`,
        [
          "a".repeat(64),
          JSON.stringify({ failureClass: "MODEL_CALL_FAILED" }),
          "b".repeat(64),
          JSON.stringify({ failureClass: "SCHEMA_INVALID" })
        ]
      );
    } finally {
      await testDb.end();
    }

    await store.recordSuccessfulCanary({
      environment: "staging",
      routingPolicyVersion: "policy-staging-1",
      observedAt: "2026-09-22T20:00:00Z",
      latencyMs: 123
    });

    await runWithPostgresTenantScope(scopeA, () =>
      store.recordBudgetSnapshot({
        portfolioId: scopeA.portfolioId,
        companyId: scopeA.companyId,
        period: "2026-09",
        companyRemainingCents: 90,
        portfolioRemainingCents: 900,
        activeConcurrentCalls: 1,
        concurrencyLimit: 4,
        snapshotAt: "2026-09-22T20:01:00Z",
        expiresAt: "2026-09-22T21:01:00Z"
      }, "2026-09-22T20:01:01Z")
    );

    await runWithPostgresTenantScope(scopeB, () =>
      store.recordBudgetSnapshot({
        portfolioId: scopeB.portfolioId,
        companyId: scopeB.companyId,
        period: "2026-09",
        companyRemainingCents: 0,
        portfolioRemainingCents: 0,
        activeConcurrentCalls: 4,
        concurrencyLimit: 4,
        snapshotAt: "2026-09-22T20:02:00Z",
        expiresAt: "2026-09-22T21:02:00Z"
      }, "2026-09-22T20:02:01Z")
    );
  });

  afterAll(async () => {
    if (database) await database.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      await admin.end();
    }
  });

  it("returns scoped error/budget state plus environment canary evidence", async () => {
    const evidence = await runWithPostgresTenantScope(scopeA, () =>
      store.read(scopeA, "staging", new Date("2026-09-22T20:05:00Z"))
    );

    expect(evidence).toEqual({
      lastSuccessfulCanaryAt: "2026-09-22T20:00:00.000Z",
      recentErrorClass: "MODEL_CALL_FAILED",
      budget: {
        state: "healthy",
        period: "2026-09",
        companyRemainingCents: 90,
        portfolioRemainingCents: 900,
        activeConcurrentCalls: 1,
        concurrencyLimit: 4,
        snapshotAt: "2026-09-22T20:01:00.000Z",
        expiresAt: "2026-09-22T21:01:00.000Z"
      }
    });
  });

  it("prevents cross-company AI health evidence reads at the database layer", async () => {
    const rows = await runWithPostgresTenantScope(scopeA, () =>
      database.query(
        `SELECT portfolio_id,company_id
         FROM ai_budget_health_snapshots
         WHERE company_id='company-b'`
      )
    );
    expect(rows.rows).toEqual([]);

    const audits = await runWithPostgresTenantScope(scopeA, () =>
      database.query(
        `SELECT portfolio_id,company_id
         FROM ai_call_audits
         WHERE company_id='company-b'`
      )
    );
    expect(audits.rows).toEqual([]);
  });

  it("classifies a different tenant budget independently", async () => {
    const evidence = await runWithPostgresTenantScope(scopeB, () =>
      store.read(scopeB, "staging", new Date("2026-09-22T20:05:00Z"))
    );
    expect(evidence.recentErrorClass).toBe("SCHEMA_INVALID");
    expect(evidence.budget.state).toBe("exhausted");
  });
});
