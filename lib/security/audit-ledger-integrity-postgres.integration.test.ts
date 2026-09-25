import { execFileSync, spawnSync } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresAuditLedger } from "@/lib/persistence/postgres/authority-stores";
import type { AuditEvent } from "@/lib/domain/audit";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const integrationDescribe = enabled ? describe.sequential : describe.skip;
const baseConnectionString = process.env.DATABASE_URL?.trim() ?? "";
const ssl = process.env.GETDONE_DB_SSL === "false" ? false : { rejectUnauthorized: true };
const root = process.cwd();

function quoteIdentifier(value: string) {
  return '"' + value.replaceAll('"', '""') + '"';
}

function databaseUrl(name: string) {
  const url = new URL(baseConnectionString);
  url.pathname = "/" + name;
  return url.toString();
}

function runVerifier(connectionString: string) {
  return spawnSync(process.execPath, ["scripts/verify-audit-ledger-integrity.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: connectionString,
      GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false"
    },
    encoding: "utf8"
  });
}

function event(id: string, occurredAt: string): AuditEvent {
  return {
    id,
    correlationId: "corr-audit-integrity",
    eventType: "job.transition",
    actor: { type: "system", id: "worker-a" },
    scope: {
      userId: "owner-a",
      portfolioId: "portfolio-a",
      companyId: "company-a"
    },
    environment: "staging",
    entityType: "job",
    entityId: "job-a",
    provenance: "audit-integrity-test",
    occurredAt,
    metadata: { id }
  };
}

integrationDescribe("tamper-evident PostgreSQL audit ledger", () => {
  const databaseName = `getdone_audit_integrity_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let database: PostgresDatabase;
  let connectionString: string;

  beforeAll(async () => {
    if (!baseConnectionString) throw new Error("DATABASE_URL is required");
    admin = new Pool({
      connectionString: baseConnectionString,
      max: 2,
      application_name: "getdone-audit-integrity-admin",
      ssl
    });
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    connectionString = databaseUrl(databaseName);
    execFileSync(process.execPath, ["scripts/migrate-postgres.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: connectionString,
        GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false"
      },
      stdio: "pipe"
    });
    pool = new Pool({
      connectionString,
      max: 4,
      application_name: "getdone-audit-integrity-test",
      ssl
    });
    database = new PostgresDatabase({
      connectionString,
      ssl: process.env.GETDONE_DB_SSL !== "false",
      maxConnections: 4
    });

    const ledger = new PostgresAuditLedger(database);
    await Promise.all([
      ledger.append(event("audit-1", "2026-09-25T04:00:00.000Z")),
      ledger.append(event("audit-2", "2026-09-25T04:00:01.000Z")),
      ledger.append(event("audit-3", "2026-09-25T04:00:02.000Z"))
    ]);
  });

  afterAll(async () => {
    await database?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      await admin.end();
    }
  });

  it("verifies the intact chain and serializes concurrent appends", async () => {
    const rows = await pool.query(
      `SELECT id,chain_sequence,previous_event_hash,event_hash
       FROM audit_events
       ORDER BY chain_sequence`
    );
    expect(rows.rows.map((row) => Number(row.chain_sequence))).toEqual([1, 2, 3]);
    expect(rows.rows[0].previous_event_hash).toBe("0".repeat(64));
    expect(rows.rows[1].previous_event_hash).toBe(rows.rows[0].event_hash);
    expect(rows.rows[2].previous_event_hash).toBe(rows.rows[1].event_hash);

    const result = runVerifier(connectionString);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      ledgerCount: 1,
      verifiedEvents: 3,
      failures: []
    });
  });

  it("detects payload mutation", async () => {
    await pool.query(
      `UPDATE audit_events
       SET payload=jsonb_set(payload,'{metadata,tampered}','true'::jsonb,true)
       WHERE id='audit-2'`
    );
    const result = runVerifier(connectionString);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("EVENT_HASH_MISMATCH");
    await pool.query(
      `UPDATE audit_events
       SET payload=payload #- '{metadata,tampered}'
       WHERE id='audit-2'`
    );
  });

  it("detects deletion, including tail deletion through the independent head", async () => {
    const deleted = await pool.query(
      "DELETE FROM audit_events WHERE id='audit-3' RETURNING *"
    );
    const result = runVerifier(connectionString);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/EVENT_COUNT_MISMATCH|HEAD_SEQUENCE_MISMATCH|HEAD_HASH_MISMATCH/);

    const row = deleted.rows[0];
    await pool.query(
      `INSERT INTO audit_events
        (sequence,id,correlation_id,portfolio_id,company_id,entity_type,entity_id,
         occurred_at,payload,chain_sequence,previous_event_hash,event_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`,
      [
        row.sequence,row.id,row.correlation_id,row.portfolio_id,row.company_id,
        row.entity_type,row.entity_id,row.occurred_at,JSON.stringify(row.payload),
        row.chain_sequence,row.previous_event_hash,row.event_hash
      ]
    );
  });

  it("detects an inserted event not committed by the chain head", async () => {
    await pool.query(
      `INSERT INTO audit_events
        (id,correlation_id,portfolio_id,company_id,entity_type,entity_id,occurred_at,payload,
         chain_sequence,previous_event_hash,event_hash)
       VALUES(
         'audit-rogue','corr-rogue','portfolio-a','company-a','job','job-a',now(),
         '{"id":"audit-rogue"}'::jsonb,4,repeat('0',64),repeat('a',64)
       )`
    );
    const result = runVerifier(connectionString);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/EVENT_COUNT_MISMATCH|HEAD_SEQUENCE_MISMATCH|PREVIOUS_HASH_MISMATCH|EVENT_HASH_MISMATCH/);
    await pool.query("DELETE FROM audit_events WHERE id='audit-rogue'");
  });

  it("detects reordered chain positions", async () => {
    const ordered = await pool.query<{ id: string; chain_sequence: number | string }>(
      `SELECT id,chain_sequence
       FROM audit_events
       WHERE portfolio_id='portfolio-a' AND company_id='company-a'
       ORDER BY chain_sequence
       LIMIT 2`
    );
    const firstId = ordered.rows[0]?.id;
    const secondId = ordered.rows[1]?.id;
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();

    await pool.query("UPDATE audit_events SET chain_sequence=99 WHERE id=$1", [firstId]);
    await pool.query("UPDATE audit_events SET chain_sequence=1 WHERE id=$1", [secondId]);
    await pool.query("UPDATE audit_events SET chain_sequence=2 WHERE id=$1", [firstId]);

    const result = runVerifier(connectionString);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/EVENT_HASH_MISMATCH|PREVIOUS_HASH_MISMATCH|STORAGE_SEQUENCE_REORDER/);

    await pool.query("UPDATE audit_events SET chain_sequence=99 WHERE id=$1", [firstId]);
    await pool.query("UPDATE audit_events SET chain_sequence=2 WHERE id=$1", [secondId]);
    await pool.query("UPDATE audit_events SET chain_sequence=1 WHERE id=$1", [firstId]);
  });
});
