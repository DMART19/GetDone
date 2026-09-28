import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import { createValidationReceiptExecutionArtifact } from "@/lib/orchestration/execution-artifacts";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresAuthorizationGrantStore } from "@/lib/persistence/postgres/authority-stores";
import { PostgresOwnerIntentStore } from "@/lib/persistence/postgres/control-api-stores";
import { PostgresOrchestrationExecutionArtifactStore } from "@/lib/persistence/postgres/orchestration-execution-artifact-store";
import { PostgresTaskGenerationDedupeStore } from "@/lib/persistence/postgres/orchestration-task-dedupe-store";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";
import { TaskGenerator } from "@/lib/planning/task-generator";
import { validPlan } from "@/lib/planning/test-fixture";
import { autoGrantFor, fixtureNow, receiptFor } from "@/lib/planning/test-security-fixture";
import { hashPlan } from "@/lib/planning/plan-hash";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const integrationDescribe = enabled ? describe.sequential : describe.skip;
const connectionString = process.env.DATABASE_URL?.trim() ?? "";
const ssl = process.env.GETDONE_DB_SSL === "false"
  ? false
  : { rejectUnauthorized: true };

integrationDescribe("PostgreSQL governed execution persistence", () => {
  const suffix = randomUUID();
  const portfolioId = `portfolio-execution-${suffix}`;
  const companyId = `company-execution-${suffix}`;
  const intentId = `intent-execution-${suffix}`;
  const correlationId = `correlation-execution-${suffix}`;
  const runId = `orchestration:owner-intent:${intentId}`;

  let admin: Pool;
  let database: PostgresDatabase;

  beforeAll(async () => {
    if (!connectionString) throw new Error("DATABASE_URL is required");
    admin = new Pool({
      connectionString,
      max: 2,
      application_name: "getdone-governed-execution-admin",
      ssl
    });
    database = new PostgresDatabase({
      connectionString,
      maxConnections: 2,
      runtimeRole: "getdone_tenant_runtime",
      ssl: process.env.GETDONE_DB_SSL !== "false"
    });

    const record: OwnerIntentRecord = Object.freeze({
      id: intentId,
      correlationId,
      portfolioId,
      companyId,
      environment: "staging",
      userId: "user-a",
      message: "Execute governed test work.",
      channel: "chat",
      status: "accepted",
      receivedAt: fixtureNow.toISOString()
    });
    await runWithPostgresTenantScope(
      { portfolioId, companyId },
      () => new PostgresOwnerIntentStore(database).create(
        record,
        `governed-execution-${suffix}`
      )
    );
  });

  afterAll(async () => {
    if (database) await database.close();
    if (admin) {
      await admin.query(
        "DELETE FROM orchestration_task_generation_claims WHERE portfolio_id=$1 AND company_id=$2",
        [portfolioId, companyId]
      );
      await admin.query(
        "DELETE FROM authorization_consumptions WHERE grant_id IN (SELECT id FROM authorization_grants WHERE portfolio_id=$1 AND company_id=$2)",
        [portfolioId, companyId]
      );
      await admin.query(
        "DELETE FROM authorization_grants WHERE portfolio_id=$1 AND company_id=$2",
        [portfolioId, companyId]
      );
      await admin.query(
        "DELETE FROM orchestration_execution_artifacts WHERE run_id=$1",
        [runId]
      );
      await admin.query("DELETE FROM orchestration_outbox WHERE run_id=$1", [runId]);
      await admin.query("DELETE FROM orchestration_runs WHERE id=$1", [runId]);
      await admin.query("DELETE FROM owner_intents WHERE id=$1", [intentId]);
      await admin.end();
    }
  });

  function run(): OrchestrationRun {
    return Object.freeze({
      id: runId,
      correlationId,
      portfolioId,
      companyId,
      environment: "staging",
      authorityUserId: "user-a",
      initiatingActor: Object.freeze({ type: "user" as const, id: "user-a" }),
      source: Object.freeze({ kind: "owner-intent" as const, ownerIntentId: intentId }),
      state: "authorized",
      attempt: 1,
      version: 7,
      availableAt: fixtureNow.toISOString(),
      createdAt: fixtureNow.toISOString(),
      updatedAt: fixtureNow.toISOString()
    });
  }

  it("persists immutable execution evidence under tenant RLS", async () => {
    const plan = validPlan({
      scope: {
        portfolioId,
        companyId,
        environment: "staging",
        dataClass: "internal"
      }
    });
    const receipt = receiptFor(plan, fixtureNow);
    const artifact = createValidationReceiptExecutionArtifact({
      id: `validation-receipt-artifact-${suffix}`,
      runId,
      correlationId,
      planHash: hashPlan(plan),
      receipt,
      createdAt: fixtureNow.toISOString()
    });
    const store = new PostgresOrchestrationExecutionArtifactStore(database);

    await expect(store.append(run(), {
      kind: "validation-receipt",
      value: artifact
    })).resolves.toEqual({ created: true });
    await expect(store.append(run(), {
      kind: "validation-receipt",
      value: artifact
    })).resolves.toEqual({ created: false });

    await expect(store.latestValidationReceipt(run())).resolves.toEqual(artifact);

    await expect(runWithPostgresTenantScope(
      { portfolioId, companyId },
      () => database.query(
        `UPDATE orchestration_execution_artifacts
         SET predecessor_hash='tampered'
         WHERE id=$1`,
        [artifact.id]
      )
    )).rejects.toThrow();
  });

  it("atomically deduplicates logical Task generation and consumes one exact grant", async () => {
    const plan = validPlan({
      scope: {
        portfolioId,
        companyId,
        environment: "staging",
        dataClass: "internal"
      }
    });
    const receipt = receiptFor(plan, fixtureNow);
    const grant = autoGrantFor(plan, plan.steps[0].id, receipt, fixtureNow);

    await runWithPostgresTenantScope(
      { portfolioId, companyId },
      () => new PostgresAuthorizationGrantStore(database).insert(grant)
    );

    const generator = new TaskGenerator(
      new PostgresTaskGenerationDedupeStore(database),
      () => `task-execution-${suffix}`,
      () => fixtureNow
    );
    const input = {
      plan,
      validationReceipt: receipt,
      authorizationGrants: { [plan.steps[0].id]: grant }
    };

    const first = await generator.generate(input);
    const retry = await generator.generate(input);

    expect(first.status).toBe("created");
    expect(retry.status).toBe("duplicates-only");
    expect(retry.duplicateTasks[0]?.id).toBe(first.tasks[0]?.id);

    const claims = await admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM orchestration_task_generation_claims
       WHERE portfolio_id=$1 AND company_id=$2`,
      [portfolioId, companyId]
    );
    const consumptions = await admin.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM authorization_consumptions WHERE grant_id=$1",
      [grant.id]
    );
    expect(Number(claims.rows[0]?.count)).toBe(1);
    expect(Number(consumptions.rows[0]?.count)).toBe(1);
  });

  it("does not expose execution artifacts across tenant scope", async () => {
    const store = new PostgresOrchestrationExecutionArtifactStore(database);
    await expect(store.latestValidationReceipt({
      ...run(),
      portfolioId: "foreign-portfolio",
      companyId: "foreign-company"
    })).resolves.toBeNull();
  });
});
