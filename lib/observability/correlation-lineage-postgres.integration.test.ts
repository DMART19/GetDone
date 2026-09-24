import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresCorrelationLineageStore } from "@/lib/persistence/postgres/correlation-lineage-store";

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

integrationDescribe("correlation lineage PostgreSQL acceptance", () => {
  const databaseName = `getdone_correlation_${process.pid}_${Date.now()}`;
  let admin: Pool;
  let database: PostgresDatabase;
  let connectionString: string;

  beforeAll(async () => {
    if (!baseConnectionString) throw new Error("DATABASE_URL is required");
    admin = new Pool({
      connectionString: baseConnectionString,
      max: 2,
      application_name: "getdone-correlation-admin",
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
    database = new PostgresDatabase({
      connectionString,
      ssl: false,
      maxConnections: 4
    });
  });

  afterAll(async () => {
    await database?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      await admin.end();
    }
  });

  it("reconstructs owner request through final result using only correlationId", async () => {
    const correlationId = "corr-postgres-complete-1";
    const otherCorrelationId = "corr-postgres-noise";
    const at = "2026-09-24T16:30:00.000Z";
    const payload = (id: string) => ({ id, correlationId, updatedAt: at });

    await database.query(
      "INSERT INTO auth_users(id,status) VALUES($1,'active'),($2,'active')",
      ["owner-corr", "owner-noise"]
    );
    await database.query(
      `INSERT INTO owner_intents
        (id,portfolio_id,company_id,user_id,idempotency_key,received_at,payload)
       VALUES
        ($1,'portfolio-a','company-a','owner-corr','intent-key-1',$2,$3::jsonb),
        ($4,'portfolio-a','company-a','owner-noise','intent-key-2',$2,$5::jsonb)`,
      [
        "intent-corr",
        at,
        JSON.stringify({
          ...payload("intent-corr"),
          portfolioId: "portfolio-a",
          companyId: "company-a",
          userId: "owner-corr",
          environment: "staging",
          message: "ship it",
          channel: "chat",
          status: "accepted",
          receivedAt: at
        }),
        "intent-noise",
        JSON.stringify({ ...payload("intent-noise"), correlationId: otherCorrelationId })
      ]
    );

    for (const [entityType, id] of [
      ["decision", "decision-corr"],
      ["plan", "plan-corr"],
      ["task", "task-corr"],
      ["job", "job-corr"]
    ] as const) {
      await database.query(
        `INSERT INTO control_plane_entities
          (entity_type,id,portfolio_id,company_id,version,updated_at,payload)
         VALUES($1,$2,'portfolio-a','company-a',1,$3,$4::jsonb)`,
        [entityType, id, at, JSON.stringify({
          ...payload(id),
          portfolioId: "portfolio-a",
          companyId: "company-a",
          version: 1,
          state: entityType === "job" ? "succeeded" : "compiled"
        })]
      );
    }
    await database.query(
      `INSERT INTO control_plane_entities
        (entity_type,id,portfolio_id,company_id,version,updated_at,payload)
       VALUES('job','job-noise','portfolio-a','company-a',1,$1,$2::jsonb)`,
      [at, JSON.stringify({ ...payload("job-noise"), correlationId: otherCorrelationId })]
    );

    const envelope = {
      id: "queue:job-corr",
      correlationId,
      jobId: "job-corr",
      taskId: "task-corr",
      scope: {
        userId: "owner-corr",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        environment: "staging"
      },
      authorizationConsumptionHash: "consumption",
      idempotencyKey: "queue-key",
      scheduledAt: at,
      createdAt: at,
      envelopeHash: "envelope-hash"
    };
    await database.query(
      `INSERT INTO job_runtime_state
        (job_id,envelope,envelope_hash,runtime_state,version,state_hash,attempt,scheduled_at,updated_at)
       VALUES('job-corr',$1::jsonb,'envelope-hash','released',2,'state-hash',1,$2,$2)`,
      [JSON.stringify(envelope), at]
    );
    await database.query(
      `INSERT INTO job_leases
        (id,job_id,worker_id,state,expires_at,lease_hash,version,payload)
       VALUES('lease-corr','job-corr','worker-a','released',$1,'lease-hash',2,$2::jsonb)`,
      [
        "2026-09-24T17:30:00.000Z",
        JSON.stringify({
          id: "lease-corr",
          jobId: "job-corr",
          workerId: "worker-a",
          state: "released",
          correlationId
        })
      ]
    );
    await database.query(
      `INSERT INTO business_action_executions
        (request_id,job_id,adapter_id,provider_operation_id,state,request_hash,record_hash,payload,updated_at)
       VALUES('provider-request-corr','job-corr','webhook','operation-1','completed',
              'request-hash','record-hash',$1::jsonb,$2)`,
      [JSON.stringify({
        requestId: "provider-request-corr",
        jobId: "job-corr",
        correlationId,
        state: "completed"
      }), at]
    );
    await database.query(
      `INSERT INTO business_action_verification_evidence
        (evidence_id,job_id,request_id,portfolio_id,company_id,evidence_hash,payload,observed_at)
       VALUES('evidence-corr','job-corr','provider-request-corr','portfolio-a','company-a',
              'evidence-hash',$1::jsonb,$2)`,
      [JSON.stringify({
        id: "evidence-corr",
        correlationId,
        subject: { type: "job", id: "job-corr" },
        result: "pass"
      }), at]
    );
    await database.query(
      `INSERT INTO audit_events
        (id,correlation_id,portfolio_id,company_id,entity_type,entity_id,occurred_at,payload)
       VALUES('audit-corr',$1,'portfolio-a','company-a','job','job-corr',$2,$3::jsonb)`,
      [correlationId, at, JSON.stringify({
        id: "audit-corr",
        correlationId,
        eventType: "job.succeeded"
      })]
    );

    const trace = await new PostgresCorrelationLineageStore(database).reconstruct(correlationId);

    expect(trace.complete).toBe(true);
    expect(trace.missingStages).toEqual([]);
    expect(trace.artifacts.map((artifact) => artifact.stage)).toEqual([
      "owner-request",
      "decision",
      "plan",
      "task",
      "job",
      "queue",
      "worker",
      "provider",
      "verification",
      "audit",
      "owner-result"
    ]);
    expect(trace.artifacts.every((artifact) => artifact.correlationId === correlationId))
      .toBe(true);
    expect(JSON.stringify(trace.artifacts)).not.toContain("job-noise");
    expect(JSON.stringify(trace.artifacts)).not.toContain(otherCorrelationId);
  });
});
