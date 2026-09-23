import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { PostgresDatabase } from "@/lib/persistence/postgres/client";
import {
  assertPostgresReadyAtStartup,
  PostgresRuntime,
  REQUIRED_POSTGRES_INDEXES,
  REQUIRED_POSTGRES_MIGRATION,
  REQUIRED_POSTGRES_RELATIONS
} from "@/lib/persistence/postgres/runtime.server";

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return {
    command: "",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows
  };
}

class FakeReadinessDatabase {
  connected = true;
  inspectionFails = false;
  migration: string | undefined = REQUIRED_POSTGRES_MIGRATION;
  missing = new Set<string>();
  isolation = "serializable";
  backupAt = new Date().toISOString();
  backupHash = "a".repeat(64);

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<R>> {
    if (text === "SELECT 1") {
      if (!this.connected) throw new Error("offline");
      return result([]) as unknown as QueryResult<R>;
    }
    if (this.inspectionFails) throw new Error("inspection failed");
    if (text.includes("to_regclass")) {
      const names = (values?.[0] ?? []) as readonly string[];
      return result(names.map((name) => ({
        name,
        present: !this.missing.has(name)
      }))) as unknown as QueryResult<R>;
    }
    if (text.includes("getdone_schema_migrations")) {
      return result(this.migration ? [{ version: this.migration }] : []) as unknown as QueryResult<R>;
    }
    if (text.includes("database_backup_evidence")) {
      return result(this.backupAt ? [{
        completed_at: this.backupAt,
        verification_hash: this.backupHash
      }] : []) as unknown as QueryResult<R>;
    }
    throw new Error(`Unexpected query: ${text}`);
  }

  async serializableTransactionIsolation() {
    if (this.inspectionFails) throw new Error("inspection failed");
    return this.isolation;
  }

  async close() {}
}

function runtime(fake: FakeReadinessDatabase, backupMaxAgeHours = 24) {
  return new PostgresRuntime(fake as unknown as PostgresDatabase, backupMaxAgeHours);
}

describe("PostgreSQL startup readiness gate", () => {
  it("reports ready only when the complete production persistence contract is healthy", async () => {
    const fake = new FakeReadinessDatabase();
    const health = await runtime(fake).assertReady();
    expect(health).toMatchObject({
      connected: true,
      inspectionSucceeded: true,
      ready: true,
      schemaCurrent: true,
      requiredRelationsPresent: true,
      missingRelations: [],
      requiredIndexesPresent: true,
      missingIndexes: [],
      transactionIsolationSerializable: true,
      transactionIsolation: "serializable",
      backupFresh: true
    });
  });

  it("distinguishes an unreachable database from an inspection failure", async () => {
    const offline = new FakeReadinessDatabase();
    offline.connected = false;
    await expect(runtime(offline).assertReady()).rejects.toThrow(/not reachable/);

    const broken = new FakeReadinessDatabase();
    broken.inspectionFails = true;
    const health = await runtime(broken).health();
    expect(health).toMatchObject({
      connected: true,
      inspectionSucceeded: false,
      ready: false
    });
    await expect(runtime(broken).assertReady()).rejects.toThrow(/inspection failed/);
  });

  it("rejects stale schema migration state", async () => {
    const fake = new FakeReadinessDatabase();
    fake.migration = "2026-09-22.2";
    await expect(runtime(fake).assertReady()).rejects.toThrow(/schema is not current/);
  });

  it("rejects missing required relations", async () => {
    const fake = new FakeReadinessDatabase();
    fake.missing.add(REQUIRED_POSTGRES_RELATIONS.at(-1)!);
    const health = await runtime(fake).health();
    expect(health.requiredRelationsPresent).toBe(false);
    expect(health.missingRelations).toEqual([REQUIRED_POSTGRES_RELATIONS.at(-1)]);
    await expect(runtime(fake).assertReady()).rejects.toThrow(/required relations are missing/);
  });

  it("rejects missing required indexes", async () => {
    const fake = new FakeReadinessDatabase();
    fake.missing.add(REQUIRED_POSTGRES_INDEXES[0]);
    const health = await runtime(fake).health();
    expect(health.requiredIndexesPresent).toBe(false);
    expect(health.missingIndexes).toEqual([REQUIRED_POSTGRES_INDEXES[0]]);
    await expect(runtime(fake).assertReady()).rejects.toThrow(/required indexes are missing/);
  });

  it("rejects a non-serializable production transaction", async () => {
    const fake = new FakeReadinessDatabase();
    fake.isolation = "read committed";
    await expect(runtime(fake).assertReady()).rejects.toThrow(/not serializable/);
  });

  it("rejects missing, malformed, stale, and future-dated backup verification evidence", async () => {
    const missing = new FakeReadinessDatabase();
    missing.backupAt = "";
    await expect(runtime(missing).assertReady()).rejects.toThrow(/backup verification evidence/);

    const malformed = new FakeReadinessDatabase();
    malformed.backupHash = "not-a-sha256";
    await expect(runtime(malformed).assertReady()).rejects.toThrow(/backup verification evidence/);

    const stale = new FakeReadinessDatabase();
    stale.backupAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    await expect(runtime(stale).assertReady()).rejects.toThrow(/backup verification evidence/);

    const future = new FakeReadinessDatabase();
    future.backupAt = new Date(Date.now() + 60_000).toISOString();
    await expect(runtime(future).assertReady()).rejects.toThrow(/backup verification evidence/);
  });

  it("gates staging and production startup while leaving development unconnected", async () => {
    const fake = new FakeReadinessDatabase();
    const readyRuntime = runtime(fake);

    await expect(assertPostgresReadyAtStartup(
      { NODE_ENV: "production", GETDONE_RUNTIME_ENV: "production" },
      readyRuntime
    )).resolves.toMatchObject({ ready: true });

    await expect(assertPostgresReadyAtStartup(
      { GETDONE_RUNTIME_ENV: "staging" },
      readyRuntime
    )).resolves.toMatchObject({ ready: true });

    await expect(assertPostgresReadyAtStartup(
      { GETDONE_RUNTIME_ENV: "development" },
      readyRuntime
    )).resolves.toBeNull();

    await expect(assertPostgresReadyAtStartup(
      { NODE_ENV: "production" },
      readyRuntime
    )).rejects.toThrow(/GETDONE_RUNTIME_ENV is required/);

    await expect(assertPostgresReadyAtStartup(
      { GETDONE_RUNTIME_ENV: "invalid" },
      readyRuntime
    )).rejects.toThrow(/development, staging, or production/);
  });
});
