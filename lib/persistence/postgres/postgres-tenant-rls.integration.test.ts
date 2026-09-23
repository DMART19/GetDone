import { spawnSync } from "node:child_process";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

async function setTenant(client: PoolClient, portfolioId: string, companyId: string) {
  await client.query("SET ROLE getdone_tenant_runtime");
  await client.query("BEGIN");
  await client.query(
    `SELECT
       set_config('getdone.portfolio_id',$1,true),
       set_config('getdone.company_id',$2,true)`,
    [portfolioId, companyId]
  );
}

async function ids(client: PoolClient, sql: string): Promise<string[]> {
  const result = await client.query<{ id: string }>(sql);
  return result.rows.map((row) => row.id).sort();
}

function expectNoMutation(result: QueryResult) {
  expect(result.rowCount).toBe(0);
}

integrationDescribe("PostgreSQL tenant RLS", () => {
  const databaseName = `getdone_rls_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let connectionString: string;

  beforeAll(async () => {
    if (!baseConnectionString) throw new Error("DATABASE_URL is required");
    adminPool = new Pool({
      connectionString: baseConnectionString,
      max: 2,
      application_name: "getdone-rls-admin",
      ssl
    });
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    connectionString = databaseUrl(databaseName);
    runMigrations(connectionString);
    pool = new Pool({
      connectionString,
      max: 4,
      application_name: "getdone-rls-test",
      ssl
    });

    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 60 * 60_000).toISOString();

    for (const tenant of ["a", "b"] as const) {
      const portfolioId = `portfolio-${tenant}`;
      const companyId = `company-${tenant}`;
      for (const entityType of ["decision", "job", "resource"] as const) {
        const id = `${entityType}-${tenant}`;
        await pool.query(
          `INSERT INTO control_plane_entities
            (entity_type,id,portfolio_id,company_id,version,updated_at,payload)
           VALUES($1,$2,$3,$4,1,$5,$6::jsonb)`,
          [
            entityType,
            id,
            portfolioId,
            companyId,
            now,
            JSON.stringify({
              id,
              portfolioId,
              companyId,
              version: 1,
              updatedAt: now,
              state: entityType === "job" ? "queued" : undefined
            })
          ]
        );
      }

      await pool.query(
        `INSERT INTO authorization_grants
          (id,portfolio_id,company_id,status,expires_at,grant_hash,payload)
         VALUES($1,$2,$3,'active',$4,$5,$6::jsonb)`,
        [
          `grant-${tenant}`,
          portfolioId,
          companyId,
          expires,
          tenant.repeat(64),
          JSON.stringify({ id: `grant-${tenant}`, portfolioId, companyId })
        ]
      );

      await pool.query(
        `INSERT INTO authorization_consumptions
          (id,grant_id,consumer_type,consumer_id,consumption_hash,consumed_at,payload)
         VALUES($1,$2,'task',$3,$4,$5,$6::jsonb)`,
        [
          `consumption-${tenant}`,
          `grant-${tenant}`,
          `task-${tenant}`,
          (tenant === "a" ? "c" : "d").repeat(64),
          now,
          JSON.stringify({ id: `consumption-${tenant}`, grantId: `grant-${tenant}` })
        ]
      );

      await pool.query(
        `INSERT INTO business_action_executions
          (request_id,job_id,adapter_id,provider_operation_id,state,request_hash,record_hash,payload,updated_at)
         VALUES($1,$2,'configured-http',NULL,'accepted',$3,$4,$5::jsonb,$6)`,
        [
          `request-${tenant}`,
          `job-${tenant}`,
          (tenant === "a" ? "e" : "f").repeat(64),
          (tenant === "a" ? "1" : "2").repeat(64),
          JSON.stringify({ requestId: `request-${tenant}`, jobId: `job-${tenant}` }),
          now
        ]
      );

      await pool.query(
        `INSERT INTO verification_receipts
          (id,portfolio_id,company_id,subject_type,subject_id,expires_at,receipt_hash,payload)
         VALUES($1,$2,$3,'job',$4,$5,$6,$7::jsonb)`,
        [
          `receipt-${tenant}`,
          portfolioId,
          companyId,
          `job-${tenant}`,
          expires,
          (tenant === "a" ? "3" : "4").repeat(64),
          JSON.stringify({ id: `receipt-${tenant}`, portfolioId, companyId })
        ]
      );

      await pool.query(
        `INSERT INTO business_action_verification_evidence
          (evidence_id,job_id,request_id,portfolio_id,company_id,evidence_hash,payload,observed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [
          `evidence-${tenant}`,
          `job-${tenant}`,
          `request-${tenant}`,
          portfolioId,
          companyId,
          (tenant === "a" ? "5" : "6").repeat(64),
          JSON.stringify({ id: `evidence-${tenant}`, portfolioId, companyId }),
          now
        ]
      );

      await pool.query(
        `INSERT INTO audit_events
          (id,correlation_id,portfolio_id,company_id,entity_type,entity_id,occurred_at,payload)
         VALUES($1,$2,$3,$4,'job',$5,$6,$7::jsonb)`,
        [
          `audit-${tenant}`,
          `correlation-${tenant}`,
          portfolioId,
          companyId,
          `job-${tenant}`,
          now,
          JSON.stringify({ id: `audit-${tenant}`, portfolioId, companyId })
        ]
      );
    }
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      await adminPool.end();
    }
  });

  it("forces RLS on the requested tenant-sensitive persistence surfaces", async () => {
    const result = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname,relrowsecurity,relforcerowsecurity
       FROM pg_class
       WHERE relname = ANY($1::text[])
       ORDER BY relname`,
      [[
        "control_plane_entities",
        "audit_events",
        "authorization_grants",
        "authorization_consumptions",
        "verification_receipts",
        "business_action_executions",
        "business_action_verification_evidence"
      ]]
    );
    expect(result.rows).toHaveLength(7);
    expect(result.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

    const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='getdone_tenant_runtime'"
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("prevents owner A raw reads from seeing owner B decisions, jobs, resources, grants, integrations, verification, or audit data", async () => {
    const client = await pool.connect();
    try {
      await setTenant(client, "portfolio-a", "company-a");

      expect(await ids(
        client,
        "SELECT id FROM control_plane_entities WHERE entity_type='decision' ORDER BY id"
      )).toEqual(["decision-a"]);
      expect(await ids(
        client,
        "SELECT id FROM control_plane_entities WHERE entity_type='job' ORDER BY id"
      )).toEqual(["job-a"]);
      expect(await ids(
        client,
        "SELECT id FROM control_plane_entities WHERE entity_type='resource' ORDER BY id"
      )).toEqual(["resource-a"]);
      expect(await ids(client, "SELECT id FROM authorization_grants ORDER BY id"))
        .toEqual(["grant-a"]);
      expect(await ids(client, "SELECT id FROM authorization_consumptions ORDER BY id"))
        .toEqual(["consumption-a"]);

      const integration = await client.query<{ request_id: string }>(
        "SELECT request_id FROM business_action_executions ORDER BY request_id"
      );
      expect(integration.rows.map((row) => row.request_id)).toEqual(["request-a"]);

      expect(await ids(client, "SELECT id FROM verification_receipts ORDER BY id"))
        .toEqual(["receipt-a"]);

      const evidence = await client.query<{ evidence_id: string }>(
        "SELECT evidence_id FROM business_action_verification_evidence ORDER BY evidence_id"
      );
      expect(evidence.rows.map((row) => row.evidence_id)).toEqual(["evidence-a"]);

      expect(await ids(client, "SELECT id FROM audit_events ORDER BY id"))
        .toEqual(["audit-a"]);
    } finally {
      try { await client.query("ROLLBACK"); } catch {}
      try { await client.query("RESET ROLE"); } catch {}
      client.release();
    }
  });

  it("prevents owner A raw updates and deletes against owner B rows", async () => {
    const client = await pool.connect();
    try {
      await setTenant(client, "portfolio-a", "company-a");

      for (const entityId of ["decision-b", "job-b", "resource-b"]) {
        expectNoMutation(await client.query(
          "UPDATE control_plane_entities SET updated_at=now() WHERE id=$1",
          [entityId]
        ));
        expectNoMutation(await client.query(
          "DELETE FROM control_plane_entities WHERE id=$1",
          [entityId]
        ));
      }

      expectNoMutation(await client.query(
        "UPDATE authorization_grants SET status='revoked' WHERE id='grant-b'"
      ));
      expectNoMutation(await client.query(
        "DELETE FROM authorization_grants WHERE id='grant-b'"
      ));
      expectNoMutation(await client.query(
        "DELETE FROM authorization_consumptions WHERE id='consumption-b'"
      ));
      expectNoMutation(await client.query(
        "UPDATE business_action_executions SET state='failed' WHERE request_id='request-b'"
      ));
      expectNoMutation(await client.query(
        "DELETE FROM business_action_executions WHERE request_id='request-b'"
      ));
      expectNoMutation(await client.query(
        "DELETE FROM verification_receipts WHERE id='receipt-b'"
      ));
      expectNoMutation(await client.query(
        "DELETE FROM business_action_verification_evidence WHERE evidence_id='evidence-b'"
      ));
      expectNoMutation(await client.query(
        "DELETE FROM audit_events WHERE id='audit-b'"
      ));
    } finally {
      try { await client.query("ROLLBACK"); } catch {}
      try { await client.query("RESET ROLE"); } catch {}
      client.release();
    }

    const preserved = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM control_plane_entities
       WHERE id IN ('decision-b','job-b','resource-b')`
    );
    expect(preserved.rows[0]?.count).toBe(3);
  });

  it("blocks owner A from inserting a row bound to owner B scope", async () => {
    const client = await pool.connect();
    try {
      await setTenant(client, "portfolio-a", "company-a");
      await expect(client.query(
        `INSERT INTO control_plane_entities
          (entity_type,id,portfolio_id,company_id,version,updated_at,payload)
         VALUES('decision','decision-cross','portfolio-b','company-b',1,now(),'{}'::jsonb)`
      )).rejects.toMatchObject({ code: "42501" });
    } finally {
      try { await client.query("ROLLBACK"); } catch {}
      try { await client.query("RESET ROLE"); } catch {}
      client.release();
    }
  });
});
