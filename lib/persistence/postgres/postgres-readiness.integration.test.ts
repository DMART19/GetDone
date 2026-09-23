import { spawnSync } from "node:child_process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import {
  assertPostgresReadyAtStartup,
  PostgresRuntime,
  REQUIRED_POSTGRES_MIGRATION
} from "@/lib/persistence/postgres/runtime.server";

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

function runMigrations(connectionString: string) {
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
    throw new Error(
      `Migration failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
}

function runtimeFor(connectionString: string, connectionTimeoutMs = 1_000) {
  return new PostgresRuntime(
    new PostgresDatabase({
      connectionString,
      maxConnections: 1,
      statementTimeoutMs: 2_000,
      connectionTimeoutMs,
      ssl: process.env.GETDONE_DB_SSL !== "false"
    }),
    24
  );
}

async function seedFreshBackup(pool: pg.Pool) {
  await pool.query("DELETE FROM database_backup_evidence");
  await pool.query(
    `INSERT INTO database_backup_evidence
      (id,completed_at,status,backup_ref_hash,verification_hash,payload)
     VALUES($1,now(),'verified',$2,$3,$4::jsonb)`,
    [
      "task1-readiness-backup",
      "b".repeat(64),
      "a".repeat(64),
      JSON.stringify({ source: "postgres-readiness-integration" })
    ]
  );
}

integrationDescribe("production PostgreSQL startup readiness", () => {
  const databaseName = `getdone_readiness_${process.pid}_${Date.now()}`;
  let adminPool: pg.Pool;
  let testPool: pg.Pool;
  let connectionString: string;

  beforeAll(async () => {
    if (!baseConnectionString) throw new Error("DATABASE_URL is required");
    adminPool = new pg.Pool({
      connectionString: baseConnectionString,
      max: 2,
      application_name: "getdone-readiness-admin",
      ssl
    });
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    connectionString = databaseUrl(databaseName);
    runMigrations(connectionString);
    testPool = new pg.Pool({
      connectionString,
      max: 2,
      application_name: "getdone-readiness-test",
      ssl
    });
    await seedFreshBackup(testPool);
  });

  afterAll(async () => {
    if (testPool) await testPool.end();
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      await adminPool.end();
    }
  });

  it("accepts a current schema, required relations/indexes, serializable transactions, and fresh backup", async () => {
    const runtime = runtimeFor(connectionString);
    try {
      const health = await assertPostgresReadyAtStartup(
        { NODE_ENV: "production", GETDONE_RUNTIME_ENV: "production" },
        runtime
      );
      expect(health).toMatchObject({
        connected: true,
        inspectionSucceeded: true,
        ready: true,
        schemaCurrent: true,
        requiredRelationsPresent: true,
        requiredIndexesPresent: true,
        transactionIsolationSerializable: true,
        transactionIsolation: "serializable",
        backupFresh: true
      });
    } finally {
      await runtime.database.close();
    }
  });

  it("fails startup for a stale schema", async () => {
    await testPool.query(
      "DELETE FROM getdone_schema_migrations WHERE version=$1",
      [REQUIRED_POSTGRES_MIGRATION]
    );
    const runtime = runtimeFor(connectionString);
    try {
      await expect(assertPostgresReadyAtStartup(
        { NODE_ENV: "production", GETDONE_RUNTIME_ENV: "production" },
        runtime
      )).rejects.toThrow(/schema is not current/);
    } finally {
      await runtime.database.close();
      await testPool.query(
        "INSERT INTO getdone_schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING",
        [REQUIRED_POSTGRES_MIGRATION]
      );
    }
  });

  it("fails startup when PostgreSQL is unreachable", async () => {
    const url = new URL(connectionString);
    url.port = "1";
    const runtime = runtimeFor(url.toString(), 250);
    try {
      await expect(assertPostgresReadyAtStartup(
        { NODE_ENV: "production", GETDONE_RUNTIME_ENV: "production" },
        runtime
      )).rejects.toThrow(/not reachable/);
    } finally {
      await runtime.database.close();
    }
  });

  it("fails startup for stale verified backup evidence", async () => {
    await testPool.query(
      "UPDATE database_backup_evidence SET completed_at=now() - interval '48 hours'"
    );
    const runtime = runtimeFor(connectionString);
    try {
      await expect(assertPostgresReadyAtStartup(
        { NODE_ENV: "production", GETDONE_RUNTIME_ENV: "production" },
        runtime
      )).rejects.toThrow(/backup verification evidence/);
    } finally {
      await runtime.database.close();
      await testPool.query("UPDATE database_backup_evidence SET completed_at=now()");
    }
  });

  it("fails startup when a required table is missing", async () => {
    await testPool.query(
      "ALTER TABLE business_action_verification_evidence RENAME TO business_action_verification_evidence_task1_missing"
    );
    const runtime = runtimeFor(connectionString);
    try {
      const health = await runtime.health();
      expect(health.connected).toBe(true);
      expect(health.missingRelations).toContain("business_action_verification_evidence");
      await expect(runtime.assertReady()).rejects.toThrow(/required relations are missing/);
    } finally {
      await runtime.database.close();
      await testPool.query(
        "ALTER TABLE business_action_verification_evidence_task1_missing RENAME TO business_action_verification_evidence"
      );
    }
  });

  it("fails startup when a required concurrency index is missing", async () => {
    await testPool.query("DROP INDEX job_leases_one_active_per_job");
    const runtime = runtimeFor(connectionString);
    try {
      const health = await runtime.health();
      expect(health.connected).toBe(true);
      expect(health.missingIndexes).toContain("job_leases_one_active_per_job");
      await expect(runtime.assertReady()).rejects.toThrow(/required indexes are missing/);
    } finally {
      await runtime.database.close();
      await testPool.query(
        "CREATE UNIQUE INDEX job_leases_one_active_per_job ON job_leases(job_id) WHERE state = 'active'"
      );
    }
  });

  it("recovers readiness after the pooled PostgreSQL connection is terminated", async () => {
    const runtime = runtimeFor(connectionString);
    try {
      await expect(runtime.assertReady()).resolves.toMatchObject({ ready: true });

      const client = await runtime.database.pool.connect();
      const pidResult = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = pidResult.rows[0]?.pid;
      client.release();
      expect(pid).toBeTypeOf("number");

      await adminPool.query("SELECT pg_terminate_backend($1)", [pid]);
      await new Promise((resolve) => setTimeout(resolve, 100));

      await expect(runtime.assertReady()).resolves.toMatchObject({
        connected: true,
        ready: true
      });
    } finally {
      await runtime.database.close();
    }
  });
});
