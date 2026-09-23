import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readOwnerAIGatewayHealth,
  recordAIGatewayCanarySuccess
} from "@/lib/ai-gateway/health.server";
import type { AICallAuditRecord } from "@/lib/ai-gateway/contracts";
import { PostgresAICallAuditStore } from "@/lib/persistence/postgres/ai-audit-store";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const integrationDescribe = enabled ? describe.sequential : describe.skip;
const connectionString = process.env.DATABASE_URL?.trim() ?? "";

function environment() {
  return {
    OPENROUTER_API_KEY: "integration-secret-never-returned",
    GETDONE_AI_MONTHLY_COMPANY_BUDGET_CENTS: "100",
    GETDONE_AI_MODEL_PROFILES_JSON: JSON.stringify([
      {
        id: "health-primary",
        gatewayId: "openrouter",
        providerId: "openrouter",
        modelId: "provider/hidden-primary",
        enabled: true,
        validationStatus: "validated",
        roles: ["STANDARD"],
        modalities: ["text"],
        supportsTools: true,
        supportsStructuredOutput: true,
        maxContextTokens: 128000,
        allowedDataClasses: ["PUBLIC", "INTERNAL"],
        allowedEnvironments: ["staging"],
        health: "healthy",
        latencyClass: "standard",
        inputCostPerMillionTokensCents: 1,
        outputCostPerMillionTokensCents: 1,
        profileVersion: "1"
      },
      {
        id: "health-fallback",
        gatewayId: "openrouter",
        providerId: "openrouter",
        modelId: "provider/hidden-fallback",
        enabled: true,
        validationStatus: "validated",
        roles: ["STANDARD"],
        modalities: ["text"],
        supportsTools: true,
        supportsStructuredOutput: true,
        maxContextTokens: 128000,
        allowedDataClasses: ["PUBLIC", "INTERNAL"],
        allowedEnvironments: ["staging"],
        health: "healthy",
        latencyClass: "standard",
        inputCostPerMillionTokensCents: 1,
        outputCostPerMillionTokensCents: 1,
        profileVersion: "1"
      }
    ]),
    GETDONE_AI_ROUTING_POLICY_JSON: JSON.stringify({
      version: "health-policy-1",
      routes: { STANDARD: ["health-primary", "health-fallback"] }
    })
  };
}

function audit(input: {
  requestId: string;
  portfolioId: string;
  companyId: string;
  actualProfileId?: string;
  validationStatus: AICallAuditRecord["validationStatus"];
  failureClass?: string;
  actualCostCents: number;
  recordedAt: string;
}): AICallAuditRecord {
  return {
    requestId: input.requestId,
    correlationId: `correlation:${input.requestId}`,
    portfolioId: input.portfolioId,
    companyId: input.companyId,
    environment: "staging",
    role: "STANDARD",
    routingPolicyVersion: "health-policy-1",
    selectedProfileId: "health-primary",
    actualProfileId: input.actualProfileId,
    gatewayId: "openrouter",
    providerId: "openrouter",
    modelId: input.actualProfileId === "health-fallback"
      ? "provider/hidden-fallback"
      : "provider/hidden-primary",
    fallbackUsed: input.actualProfileId === "health-fallback",
    estimatedCostCents: input.actualCostCents,
    actualCostCents: input.actualCostCents,
    validationStatus: input.validationStatus,
    failureClass: input.failureClass,
    recordedAt: input.recordedAt,
    auditHash: `audit-hash:${input.requestId}`
  };
}

integrationDescribe("AI Gateway owner health PostgreSQL isolation", () => {
  let adminPool: Pool;
  let db: PostgresDatabase;

  const ownerScope = {
    userId: "owner-health-a",
    portfolioId: "portfolio-health-a",
    companyId: "company-health-a",
    environment: "staging" as const
  };
  const foreignScope = {
    userId: "owner-health-b",
    portfolioId: "portfolio-health-b",
    companyId: "company-health-b",
    environment: "staging" as const
  };

  beforeAll(async () => {
    if (!connectionString) throw new Error("DATABASE_URL is required");
    adminPool = new Pool({
      connectionString,
      max: 2,
      application_name: "getdone-ai-health-integration-admin",
      ssl: process.env.GETDONE_DB_SSL === "false"
        ? false
        : { rejectUnauthorized: true }
    });
    db = new PostgresDatabase({
      connectionString,
      maxConnections: 2,
      statementTimeoutMs: 5_000,
      connectionTimeoutMs: 2_000,
      runtimeRole: "getdone_tenant_runtime",
      ssl: process.env.GETDONE_DB_SSL !== "false"
    });

    const store = new PostgresAICallAuditStore(db);

    await runWithPostgresTenantScope(ownerScope, async () => {
      await store.appendAudit(audit({
        requestId: "owner-primary-success",
        portfolioId: ownerScope.portfolioId,
        companyId: ownerScope.companyId,
        actualProfileId: "health-primary",
        validationStatus: "valid",
        actualCostCents: 30,
        recordedAt: "2026-09-23T08:00:00.000Z"
      }));
      await store.appendAudit(audit({
        requestId: "owner-fallback-success",
        portfolioId: ownerScope.portfolioId,
        companyId: ownerScope.companyId,
        actualProfileId: "health-fallback",
        validationStatus: "valid",
        actualCostCents: 25,
        recordedAt: "2026-09-23T08:10:00.000Z"
      }));
      await store.appendAudit(audit({
        requestId: "owner-recent-error",
        portfolioId: ownerScope.portfolioId,
        companyId: ownerScope.companyId,
        validationStatus: "failed",
        failureClass: "MODEL_CALL_FAILED",
        actualCostCents: 0,
        recordedAt: "2026-09-23T08:20:00.000Z"
      }));
      await recordAIGatewayCanarySuccess({
        db,
        scope: ownerScope,
        observedAt: "2026-09-23T08:30:00.000Z"
      });
    });

    await runWithPostgresTenantScope(foreignScope, async () => {
      await store.appendAudit(audit({
        requestId: "foreign-error",
        portfolioId: foreignScope.portfolioId,
        companyId: foreignScope.companyId,
        validationStatus: "failed",
        failureClass: "FOREIGN_SECRET_ERROR",
        actualCostCents: 99,
        recordedAt: "2026-09-23T08:50:00.000Z"
      }));
      await recordAIGatewayCanarySuccess({
        db,
        scope: foreignScope,
        observedAt: "2026-09-23T08:55:00.000Z"
      });
    });
  });

  afterAll(async () => {
    if (db) await db.close();
    if (adminPool) {
      await adminPool.query(
        `DELETE FROM control_plane_entities
         WHERE entity_type='ai-gateway-canary'
           AND portfolio_id IN ('portfolio-health-a','portfolio-health-b')`
      );
      await adminPool.query(
        `DELETE FROM ai_call_audits
         WHERE portfolio_id IN ('portfolio-health-a','portfolio-health-b')`
      );
      await adminPool.end();
    }
  });

  it("returns only owner-scoped safe health state", async () => {
    const health = await readOwnerAIGatewayHealth(
      ownerScope,
      environment(),
      { db, now: new Date("2026-09-23T09:00:00.000Z") }
    );

    expect(health).toMatchObject({
      configured: true,
      status: "ready",
      activeRoutingPolicyVersion: "health-policy-1",
      lastSuccessfulCanaryAt: "2026-09-23T08:30:00.000Z",
      primary: {
        configured: true,
        available: true,
        lastSuccessfulCallAt: "2026-09-23T08:00:00.000Z"
      },
      fallback: {
        configured: true,
        available: true,
        lastSuccessfulCallAt: "2026-09-23T08:10:00.000Z"
      },
      recentErrorClass: "MODEL_CALL_FAILED",
      budget: {
        configured: true,
        status: "healthy",
        spentCents: 55,
        limitCents: 100,
        remainingCents: 45
      }
    });

    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain("FOREIGN_SECRET_ERROR");
    expect(serialized).not.toContain("08:55:00");
    expect(serialized).not.toContain("hidden-primary");
    expect(serialized).not.toContain("hidden-fallback");
    expect(serialized).not.toContain("integration-secret-never-returned");
    expect(serialized).not.toContain("health-primary");
    expect(serialized).not.toContain("health-fallback");
  });
});
