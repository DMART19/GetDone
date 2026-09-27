import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import { PostgresOwnerIntentStore } from "@/lib/persistence/postgres/control-api-stores";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresOrchestrationRuntimeStore } from "@/lib/persistence/postgres/orchestration-store";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";
import { OrchestrationCoordinator } from "@/lib/orchestration/coordinator";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const integrationDescribe = enabled ? describe.sequential : describe.skip;
const connectionString = process.env.DATABASE_URL?.trim() ?? "";
const ssl = process.env.GETDONE_DB_SSL === "false"
  ? false
  : { rejectUnauthorized: true };

integrationDescribe("PostgreSQL orchestration runtime", () => {
  const suffix = randomUUID();
  const portfolioId = `portfolio-orchestration-${suffix}`;
  const companyId = `company-orchestration-${suffix}`;
  const userId = `user-orchestration-${suffix}`;
  const intentId = `intent-orchestration-${suffix}`;
  const correlationId = `correlation-orchestration-${suffix}`;
  const idempotencyKey = `orchestration-test-${suffix}`;
  const runId = `orchestration:owner-intent:${intentId}`;

  let admin: Pool;
  let database: PostgresDatabase;

  beforeAll(async () => {
    if (!connectionString) throw new Error("DATABASE_URL is required");
    admin = new Pool({
      connectionString,
      max: 2,
      application_name: "getdone-orchestration-integration-admin",
      ssl
    });
    database = new PostgresDatabase({
      connectionString,
      maxConnections: 2,
      runtimeRole: "getdone_tenant_runtime",
      ssl: process.env.GETDONE_DB_SSL !== "false"
    });
  });

  afterAll(async () => {
    if (database) await database.close();
    if (admin) {
      await admin.query("DELETE FROM orchestration_outbox WHERE run_id=$1", [runId]);
      await admin.query("DELETE FROM orchestration_runs WHERE id=$1", [runId]);
      await admin.query("DELETE FROM owner_intents WHERE id=$1", [intentId]);
      await admin.end();
    }
  });

  it("atomically turns an accepted OwnerIntent into one durable orchestration trigger", async () => {
    const record: OwnerIntentRecord = Object.freeze({
      id: intentId,
      correlationId,
      portfolioId,
      companyId,
      environment: "staging",
      userId,
      message: "Inspect the company and prepare safe work.",
      channel: "chat",
      status: "accepted",
      receivedAt: new Date().toISOString()
    });

    const store = new PostgresOwnerIntentStore(database);
    const first = await runWithPostgresTenantScope(
      { portfolioId, companyId },
      () => store.create(record, idempotencyKey)
    );
    const second = await runWithPostgresTenantScope(
      { portfolioId, companyId },
      () => store.create(record, idempotencyKey)
    );

    expect(first.id).toBe(intentId);
    expect(second.id).toBe(intentId);

    const persistedRun = await admin.query<{
      state: string;
      correlation_id: string;
      source_kind: string;
      source_id: string;
    }>(
      "SELECT state,correlation_id,source_kind,source_id FROM orchestration_runs WHERE id=$1",
      [runId]
    );
    expect(persistedRun.rows).toEqual([expect.objectContaining({
      state: "received",
      correlation_id: correlationId,
      source_kind: "owner-intent",
      source_id: intentId
    })]);

    const events = await admin.query<{ event_type: string; delivered_at: Date | null }>(
      "SELECT event_type,delivered_at FROM orchestration_outbox WHERE run_id=$1 ORDER BY occurred_at,id",
      [runId]
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      event_type: "orchestration.triggered",
      delivered_at: null
    });
  });

  it("defers routing to the authoritative run lease instead of hot-looping", async () => {
    const runtimeStore = new PostgresOrchestrationRuntimeStore(database);
    const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const queueEventId = `outbox:orchestration.resume:${runId}:lease-regression`;

    await admin.query(
      `UPDATE orchestration_runs
       SET lease_owner='other-orchestration-worker',lease_expires_at=$2,available_at=now()
       WHERE id=$1`,
      [runId, leaseExpiresAt]
    );
    await admin.query(
      `INSERT INTO orchestration_outbox (
         id,correlation_id,portfolio_id,company_id,event_type,run_id,
         occurred_at,available_at,attempts
       ) VALUES ($1,$2,$3,$4,'orchestration.resume',$5,now(),now(),0)`,
      [queueEventId, correlationId, portfolioId, companyId, runId]
    );

    await expect(runtimeStore.claimNext({
      workerId: `lease-regression-worker-${suffix}`,
      leaseMilliseconds: 30_000,
      now: new Date().toISOString()
    })).resolves.toBeNull();

    const queued = await admin.query<{
      claimed_by: string | null;
      delivered_at: Date | null;
      attempts: number;
      available_at: Date;
    }>(
      `SELECT claimed_by,delivered_at,attempts,available_at
       FROM orchestration_outbox WHERE id=$1`,
      [queueEventId]
    );
    expect(queued.rows[0]?.claimed_by).toBeNull();
    expect(queued.rows[0]?.delivered_at).toBeNull();
    expect(queued.rows[0]?.attempts).toBe(1);
    expect(queued.rows[0]?.available_at.toISOString()).toBe(leaseExpiresAt);

    await admin.query("DELETE FROM orchestration_outbox WHERE id=$1", [queueEventId]);
    await admin.query(
      `UPDATE orchestration_runs
       SET lease_owner=NULL,lease_expires_at=NULL,available_at=now()
       WHERE id=$1`,
      [runId]
    );
  });

  it("claims through the routing queue, re-enters tenant scope, and advances with external wake barriers", async () => {
    const runtimeStore = new PostgresOrchestrationRuntimeStore(database);
    const coordinator = new OrchestrationCoordinator(
      runtimeStore,
      {
        advance: async (run) => {
          if (run.state === "received") {
            return {
              kind: "transition" as const,
              state: "context-building" as const,
              wake: "immediate" as const
            };
          }
          if (run.state === "context-building") {
            return {
              kind: "transition" as const,
              state: "planning" as const,
              wake: "external" as const
            };
          }
          return {
            kind: "defer" as const,
            retryAt: new Date(Date.now() + 60_000).toISOString(),
            reason: "unexpected-test-state"
          };
        }
      },
      {
        workerId: `orchestration-worker-${suffix}`,
        leaseMilliseconds: 30_000,
        errorBackoffMilliseconds: 5_000
      }
    );

    await expect(coordinator.runOnce()).resolves.toMatchObject({
      outcome: "transitioned",
      state: "context-building",
      wake: "immediate"
    });
    await expect(coordinator.runOnce()).resolves.toMatchObject({
      outcome: "transitioned",
      state: "planning",
      wake: "external"
    });

    const persisted = await admin.query<{ state: string; version: number }>(
      "SELECT state,version FROM orchestration_runs WHERE id=$1",
      [runId]
    );
    expect(persisted.rows[0]).toMatchObject({ state: "planning", version: 3 });

    const queue = await admin.query<{
      event_type: string;
      delivered_at: Date | null;
    }>(
      "SELECT event_type,delivered_at FROM orchestration_outbox WHERE run_id=$1 ORDER BY occurred_at,id",
      [runId]
    );
    expect(queue.rows).toHaveLength(2);
    expect(queue.rows.every((row) => row.delivered_at !== null)).toBe(true);

    const audits = await admin.query<{ event_type: string; correlation_id: string }>(
      `SELECT event_type,correlation_id
       FROM audit_events
       WHERE correlation_id=$1 AND entity_type='orchestration-run'
       ORDER BY occurred_at,id`,
      [correlationId]
    );
    expect(audits.rows.map((row) => row.event_type)).toEqual([
      "orchestration.created",
      "orchestration.state-transitioned",
      "orchestration.state-transitioned"
    ]);
  });
});
