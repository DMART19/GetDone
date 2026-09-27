import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import { OrchestrationContextBuilder } from "@/lib/orchestration/context-builder";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresOwnerIntentStore } from "@/lib/persistence/postgres/control-api-stores";
import { PostgresOwnerIntentContextSource } from "@/lib/persistence/postgres/orchestration-context-source";
import { PostgresOrchestrationPlanningArtifactStore } from "@/lib/persistence/postgres/orchestration-planning-artifact-store";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const integrationDescribe = enabled ? describe.sequential : describe.skip;
const connectionString = process.env.DATABASE_URL?.trim() ?? "";
const ssl = process.env.GETDONE_DB_SSL === "false"
  ? false
  : { rejectUnauthorized: true };

integrationDescribe("PostgreSQL orchestration planning evidence", () => {
  const suffix = randomUUID();
  const portfolioId = `portfolio-planning-${suffix}`;
  const companyId = `company-planning-${suffix}`;
  const userId = `user-planning-${suffix}`;
  const intentId = `intent-planning-${suffix}`;
  const correlationId = `correlation-planning-${suffix}`;
  const idempotencyKey = `planning-test-${suffix}`;
  const runId = `orchestration:owner-intent:${intentId}`;

  let admin: Pool;
  let database: PostgresDatabase;

  beforeAll(async () => {
    if (!connectionString) throw new Error("DATABASE_URL is required");
    admin = new Pool({
      connectionString,
      max: 2,
      application_name: "getdone-orchestration-planning-admin",
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
      await admin.query(
        "DELETE FROM orchestration_planning_artifacts WHERE run_id=$1",
        [runId]
      );
      await admin.query("DELETE FROM orchestration_outbox WHERE run_id=$1", [runId]);
      await admin.query("DELETE FROM orchestration_runs WHERE id=$1", [runId]);
      await admin.query("DELETE FROM owner_intents WHERE id=$1", [intentId]);
      await admin.end();
    }
  });

  it("persists an RLS-scoped immutable context snapshot derived from the authoritative OwnerIntent", async () => {
    const receivedAt = new Date().toISOString();
    const record: OwnerIntentRecord = Object.freeze({
      id: intentId,
      correlationId,
      portfolioId,
      companyId,
      environment: "staging",
      userId,
      message: "Inspect the current repository state.",
      channel: "chat",
      status: "accepted",
      receivedAt
    });
    const intentStore = new PostgresOwnerIntentStore(database);
    await runWithPostgresTenantScope(
      { portfolioId, companyId },
      () => intentStore.create(record, idempotencyKey)
    );

    const run: OrchestrationRun = Object.freeze({
      id: runId,
      correlationId,
      portfolioId,
      companyId,
      environment: "staging",
      authorityUserId: userId,
      initiatingActor: Object.freeze({ type: "user" as const, id: userId }),
      source: Object.freeze({ kind: "owner-intent" as const, ownerIntentId: intentId }),
      state: "context-building",
      attempt: 1,
      version: 2,
      availableAt: receivedAt,
      createdAt: receivedAt,
      updatedAt: receivedAt
    });

    const source = new PostgresOwnerIntentContextSource(database, {
      sensitivity: "internal"
    });
    const builder = new OrchestrationContextBuilder(source);
    const built = await builder.build(run);
    expect(built.kind).toBe("ready");
    if (built.kind !== "ready") throw new Error("expected ready context");

    const artifacts = new PostgresOrchestrationPlanningArtifactStore(database);
    await expect(artifacts.append(run, {
      kind: "context-snapshot",
      value: built.snapshot
    })).resolves.toEqual({ created: true });

    await expect(artifacts.append(run, {
      kind: "context-snapshot",
      value: built.snapshot
    })).resolves.toEqual({ created: false });

    const persisted = await artifacts.latestContext(run);
    expect(persisted).toMatchObject({
      id: built.snapshot.id,
      runId,
      correlationId,
      portfolioId,
      companyId,
      dataClass: "internal"
    });
    expect(persisted?.assembled.items[0]).toMatchObject({
      id: `owner-input:${intentId}`,
      content: "Inspect the current repository state."
    });

    const row = await admin.query<{
      artifact_kind: string;
      artifact_hash: string;
      payload: unknown;
    }>(
      `SELECT artifact_kind,artifact_hash,payload
       FROM orchestration_planning_artifacts
       WHERE run_id=$1`,
      [runId]
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.artifact_kind).toBe("context-snapshot");
    expect(row.rows[0]?.artifact_hash).toBe(built.snapshot.contextHash);
  });

  it("does not expose another tenant's planning artifacts through runtime RLS", async () => {
    const foreignRun: OrchestrationRun = Object.freeze({
      id: runId,
      correlationId,
      portfolioId: "foreign-portfolio",
      companyId: "foreign-company",
      environment: "staging",
      authorityUserId: userId,
      initiatingActor: Object.freeze({ type: "user" as const, id: userId }),
      source: Object.freeze({ kind: "owner-intent" as const, ownerIntentId: intentId }),
      state: "planning",
      attempt: 1,
      version: 3,
      availableAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    const artifacts = new PostgresOrchestrationPlanningArtifactStore(database);
    await expect(artifacts.latestContext(foreignRun)).resolves.toBeNull();
  });
});
