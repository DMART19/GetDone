import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AIGateway } from "@/lib/ai-gateway/gateway";
import {
  OpenRouterAIGatewayAdapter
} from "@/lib/ai-gateway/openrouter-adapter";
import type {
  AIBudgetSnapshot,
  AIRequestEnvelope,
  ModelProfile,
  ModelRoutePolicy
} from "@/lib/ai-gateway/contracts";
import { PostgresAICallAuditStore } from "@/lib/persistence/postgres/ai-audit-store";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

const enabled = process.env.GETDONE_OPENROUTER_STAGING_ACCEPTANCE === "true";
const acceptanceDescribe = enabled ? describe.sequential : describe.skip;

const apiKey = process.env.OPENROUTER_API_KEY?.trim() ?? "";
const primaryModel = process.env.GETDONE_OPENROUTER_PRIMARY_MODEL?.trim() ?? "";
const fallbackModel = process.env.GETDONE_OPENROUTER_FALLBACK_MODEL?.trim() ?? "";
const connectionString = process.env.DATABASE_URL?.trim() ?? "";
const baseUrl = process.env.OPENROUTER_BASE_URL?.trim();

const scope = Object.freeze({
  portfolioId: "portfolio-openrouter-staging",
  companyId: "company-openrouter-staging",
  environment: "staging" as const,
  userId: "openrouter-staging-acceptance"
});

const evidence: Array<{
  scenario: string;
  evidenceMode: "live-provider" | "deterministic-fault-injection" | "local-policy";
  status: "passed";
  detail?: Record<string, unknown>;
}> = [];

function record(
  scenario: string,
  evidenceMode: "live-provider" | "deterministic-fault-injection" | "local-policy",
  detail?: Record<string, unknown>
) {
  evidence.push({ scenario, evidenceMode, status: "passed", detail });
}

function profile(id: string, modelId: string): ModelProfile {
  return {
    id,
    gatewayId: "openrouter",
    providerId: "openrouter",
    modelId,
    enabled: true,
    validationStatus: "validated",
    roles: ["STANDARD"],
    modalities: ["text"],
    supportsTools: true,
    supportsStructuredOutput: true,
    maxContextTokens: 128_000,
    allowedDataClasses: ["PUBLIC", "INTERNAL"],
    allowedEnvironments: ["staging"],
    health: "healthy",
    latencyClass: "standard",
    inputCostPerMillionTokensCents: 100,
    outputCostPerMillionTokensCents: 200,
    profileVersion: "staging-acceptance-1"
  };
}

function request(id: string, allowFallback = true): AIRequestEnvelope {
  return {
    id,
    correlationId: `correlation:${id}`,
    scope,
    inputHash: "staging-acceptance-input",
    requestedAt: new Date().toISOString(),
    requirements: {
      role: "STANDARD",
      requiredModalities: ["text"],
      requiresTools: false,
      requiresStructuredOutput: true,
      minimumContextTokens: 1_000,
      estimatedInputTokens: 500,
      expectedOutputTokens: 100,
      dataClass: "INTERNAL",
      environment: "staging",
      latencyClass: "standard",
      maxCostCents: 25,
      allowFallback
    }
  };
}

function budget(overrides: Partial<AIBudgetSnapshot> = {}): AIBudgetSnapshot {
  const now = Date.now();
  return {
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    period: "staging-acceptance",
    companyRemainingCents: 1_000,
    portfolioRemainingCents: 1_000,
    activeConcurrentCalls: 0,
    concurrencyLimit: 4,
    snapshotAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
    ...overrides
  };
}

const outputSchema = z.object({
  ok: z.literal(true),
  marker: z.string().min(1)
});

function policy(...ids: string[]): ModelRoutePolicy {
  return {
    version: "openrouter-staging-acceptance-1",
    routes: { STANDARD: ids }
  };
}

function response(
  model: string,
  content: unknown,
  status = 200,
  headers: Record<string, string> = {}
) {
  return new Response(
    JSON.stringify(status >= 200 && status < 300
      ? {
          id: "staging-synthetic",
          model,
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 }
        }
      : { error: { message: String(content) } }),
    { status, headers: { "content-type": "application/json", ...headers } }
  );
}

acceptanceDescribe("real OpenRouter staging acceptance", () => {
  let adminPool: Pool;
  let database: PostgresDatabase;

  beforeAll(async () => {
    if (!apiKey) throw new Error("OPENROUTER_API_KEY staging secret is required");
    if (!primaryModel) throw new Error("GETDONE_OPENROUTER_PRIMARY_MODEL is required");
    if (!fallbackModel) throw new Error("GETDONE_OPENROUTER_FALLBACK_MODEL is required");
    if (primaryModel === fallbackModel) {
      throw new Error("Primary and fallback OpenRouter staging models must be distinct");
    }
    if (!connectionString) throw new Error("DATABASE_URL is required");

    adminPool = new Pool({
      connectionString,
      max: 2,
      application_name: "getdone-openrouter-staging-acceptance-admin",
      ssl: process.env.GETDONE_DB_SSL === "false"
        ? false
        : { rejectUnauthorized: true }
    });

    database = new PostgresDatabase({
      connectionString,
      maxConnections: 2,
      statementTimeoutMs: 30_000,
      connectionTimeoutMs: 5_000,
      runtimeRole: "getdone_tenant_runtime",
      ssl: process.env.GETDONE_DB_SSL !== "false"
    });
  });

  afterAll(async () => {
    fs.mkdirSync("test-results", { recursive: true });
    fs.writeFileSync(
      "test-results/openrouter-staging-acceptance.json",
      JSON.stringify({
        accepted: evidence.length === 11,
        generatedAt: new Date().toISOString(),
        primaryModel,
        fallbackModel,
        scenarios: evidence
      }, null, 2)
    );
    if (database) await database.close();
    if (adminPool) await adminPool.end();
  });

  it("executes the primary model live and persists Postgres usage/audit evidence", async () => {
    const id = `openrouter-primary-${randomUUID()}`;
    const primary = profile("staging-primary", primaryModel);
    const adapter = new OpenRouterAIGatewayAdapter({
      apiKey,
      baseUrl,
      maxRetries: 1,
      canary: { enabled: true, modelId: primaryModel }
    });
    const gateway = new AIGateway(
      [primary],
      policy(primary.id),
      adapter,
      new PostgresAICallAuditStore(database)
    );

    const result = await runWithPostgresTenantScope(scope, () =>
      gateway.invoke({
        request: request(id, false),
        payload: {
          messages: [{
            role: "user",
            content: 'Return exactly this JSON object: {"ok":true,"marker":"primary"}'
          }]
        },
        outputSchema,
        budget: budget()
      })
    );

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.audit).toMatchObject({
        fallbackUsed: false,
        modelId: primaryModel,
        providerId: "openrouter",
        validationStatus: "valid"
      });
    }

    const audits = await adminPool.query(
      "SELECT payload FROM ai_call_audits WHERE request_id=$1",
      [id]
    );
    const usage = await adminPool.query(
      "SELECT payload FROM ai_usage_records WHERE request_id=$1 ORDER BY attempt",
      [id]
    );
    expect(audits.rows).toHaveLength(1);
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0].payload).toMatchObject({
      modelId: primaryModel,
      providerId: "openrouter",
      outcome: "valid"
    });
    record("primary-model", "live-provider", { modelId: primaryModel });
    record("postgres-audit-persistence", "live-provider", {
      auditRows: audits.rowCount,
      usageRows: usage.rowCount
    });
  }, 120_000);

  it("falls back live when the primary provider operation fails", async () => {
    const id = `openrouter-fallback-${randomUUID()}`;
    const badPrimary = profile(
      "staging-deliberately-invalid-primary",
      `getdone/invalid-model-${randomUUID()}`
    );
    const fallback = profile("staging-fallback", fallbackModel);
    const adapter = new OpenRouterAIGatewayAdapter({
      apiKey,
      baseUrl,
      maxRetries: 0
    });
    const gateway = new AIGateway(
      [badPrimary, fallback],
      policy(badPrimary.id, fallback.id),
      adapter,
      new PostgresAICallAuditStore(database)
    );

    const result = await runWithPostgresTenantScope(scope, () =>
      gateway.invoke({
        request: request(id, true),
        payload: {
          messages: [{
            role: "user",
            content: 'Return exactly this JSON object: {"ok":true,"marker":"fallback"}'
          }]
        },
        outputSchema,
        budget: budget()
      })
    );

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.audit).toMatchObject({
        fallbackUsed: true,
        actualProfileId: fallback.id,
        modelId: fallbackModel,
        fallbackReason: "MODEL_CALL_FAILED"
      });
    }

    const usage = await adminPool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM ai_usage_records WHERE request_id=$1 ORDER BY attempt",
      [id]
    );
    expect(usage.rows).toHaveLength(2);
    expect(usage.rows[0].payload).toMatchObject({
      outcome: "failed",
      failureClass: "MODEL_CALL_FAILED"
    });
    expect(usage.rows[1].payload).toMatchObject({
      outcome: "valid",
      modelId: fallbackModel
    });
    record("fallback-model", "live-provider", { modelId: fallbackModel });
  }, 120_000);

  it("runs the concrete-model canary live", async () => {
    const adapter = new OpenRouterAIGatewayAdapter({
      apiKey,
      baseUrl,
      maxRetries: 1,
      canary: { enabled: true, modelId: primaryModel }
    });
    const result = await adapter.runCanary();
    expect(result).toMatchObject({
      enabled: true,
      ok: true,
      modelId: primaryModel
    });
    record("canary", "live-provider", {
      modelId: primaryModel,
      latencyMs: result.latencyMs
    });
  }, 120_000);

  it("survives gateway/database object reconstruction and preserves prior audit history", async () => {
    const firstId = `openrouter-restart-before-${randomUUID()}`;
    const secondId = `openrouter-restart-after-${randomUUID()}`;
    const liveProfile = profile("staging-restart-primary", primaryModel);

    const invokeFresh = async (id: string) => {
      const freshDatabase = new PostgresDatabase({
        connectionString,
        maxConnections: 1,
        statementTimeoutMs: 30_000,
        connectionTimeoutMs: 5_000,
        runtimeRole: "getdone_tenant_runtime",
        ssl: process.env.GETDONE_DB_SSL !== "false"
      });
      try {
        const freshGateway = new AIGateway(
          [liveProfile],
          policy(liveProfile.id),
          new OpenRouterAIGatewayAdapter({
            apiKey,
            baseUrl,
            maxRetries: 1
          }),
          new PostgresAICallAuditStore(freshDatabase)
        );
        return await runWithPostgresTenantScope(scope, () =>
          freshGateway.invoke({
            request: request(id, false),
            payload: {
              messages: [{
                role: "user",
                content: 'Return exactly this JSON object: {"ok":true,"marker":"restart"}'
              }]
            },
            outputSchema,
            budget: budget()
          })
        );
      } finally {
        await freshDatabase.close();
      }
    };

    expect((await invokeFresh(firstId)).kind).toBe("success");
    expect((await invokeFresh(secondId)).kind).toBe("success");

    const persisted = await adminPool.query(
      "SELECT request_id FROM ai_call_audits WHERE request_id = ANY($1::text[]) ORDER BY request_id",
      [[firstId, secondId]]
    );
    expect(persisted.rows).toHaveLength(2);
    record("restart", "live-provider", { persistedAuditRows: persisted.rowCount });
  }, 180_000);

  it("classifies timeout transport failure through the real adapter implementation", async () => {
    const p = profile("fault-timeout", primaryModel);
    const adapter = new OpenRouterAIGatewayAdapter(
      { apiKey, maxRetries: 0 },
      {
        fetchImpl: async () => {
          throw new DOMException("staging injected timeout", "TimeoutError");
        }
      }
    );
    await expect(adapter.invoke({
      requestId: "fault-timeout",
      correlationId: "fault-timeout",
      profile: p,
      input: "x",
      requirements: request("fault-timeout", false).requirements
    })).rejects.toThrow(/timed out or failed/i);
    record("timeout", "deterministic-fault-injection");
  });

  it("exercises rate-limit and HTTP 500 failure handling without relying on a real outage", async () => {
    for (const status of [429, 500]) {
      const p = profile(`fault-http-${status}`, primaryModel);
      const adapter = new OpenRouterAIGatewayAdapter(
        { apiKey, maxRetries: 0 },
        { fetchImpl: async () => response(primaryModel, `fault-${status}`, status) }
      );
      await expect(adapter.invoke({
        requestId: `fault-${status}`,
        correlationId: `fault-${status}`,
        profile: p,
        input: "x",
        requirements: request(`fault-${status}`, false).requirements
      })).rejects.toThrow(new RegExp(`HTTP ${status}`));
    }
    record("rate-limit-429", "deterministic-fault-injection");
    record("provider-500", "deterministic-fault-injection");
  });

  it("rejects malformed structured output through the gateway", async () => {
    const id = `malformed-${randomUUID()}`;
    const p = profile("fault-malformed", primaryModel);
    const adapter = new OpenRouterAIGatewayAdapter(
      { apiKey, maxRetries: 0 },
      { fetchImpl: async () => response(primaryModel, "not-json") }
    );
    const gateway = new AIGateway(
      [p],
      policy(p.id),
      adapter,
      new PostgresAICallAuditStore(database)
    );
    const result = await runWithPostgresTenantScope(scope, () =>
      gateway.invoke({
        request: request(id, false),
        payload: "x",
        outputSchema,
        budget: budget()
      })
    );
    expect(result).toMatchObject({
      kind: "unavailable",
      reason: "SCHEMA_INVALID",
      audit: { failureClass: "SCHEMA_INVALID" }
    });
    record("malformed-structured-output", "deterministic-fault-injection");
  });

  it("rejects returned-model identity mismatch through the gateway", async () => {
    const id = `identity-${randomUUID()}`;
    const p = profile("fault-identity", primaryModel);
    const adapter = new OpenRouterAIGatewayAdapter(
      { apiKey, maxRetries: 0 },
      {
        fetchImpl: async () =>
          response("unexpected/provider-model", '{"ok":true,"marker":"mismatch"}')
      }
    );
    const gateway = new AIGateway(
      [p],
      policy(p.id),
      adapter,
      new PostgresAICallAuditStore(database)
    );
    const result = await runWithPostgresTenantScope(scope, () =>
      gateway.invoke({
        request: request(id, false),
        payload: "x",
        outputSchema,
        budget: budget()
      })
    );
    expect(result).toMatchObject({
      kind: "unavailable",
      reason: "MODEL_IDENTITY_MISMATCH",
      audit: { failureClass: "MODEL_IDENTITY_MISMATCH" }
    });
    record("returned-model-mismatch", "deterministic-fault-injection");
  });

  it("fails closed on budget exhaustion before dispatching a provider request", async () => {
    let calls = 0;
    const p = profile("budget-blocked", primaryModel);
    const adapter = new OpenRouterAIGatewayAdapter(
      { apiKey, maxRetries: 0 },
      {
        fetchImpl: async () => {
          calls += 1;
          return response(primaryModel, '{"ok":true,"marker":"unexpected"}');
        }
      }
    );
    const gateway = new AIGateway([p], policy(p.id), adapter);
    await expect(gateway.invoke({
      request: request(`budget-${randomUUID()}`, false),
      payload: "x",
      outputSchema,
      budget: budget({ companyRemainingCents: 0, portfolioRemainingCents: 0 })
    })).rejects.toThrow(/budget ceiling/i);
    expect(calls).toBe(0);
    record("budget-exhaustion", "local-policy");
  });

  it("honors provider kill switch before dispatching a provider request", async () => {
    let calls = 0;
    const id = `kill-switch-${randomUUID()}`;
    const p = profile("kill-switch-primary", primaryModel);
    const adapter = new OpenRouterAIGatewayAdapter(
      { apiKey, maxRetries: 0 },
      {
        fetchImpl: async () => {
          calls += 1;
          return response(primaryModel, '{"ok":true,"marker":"unexpected"}');
        }
      }
    );
    const gateway = new AIGateway(
      [p],
      policy(p.id),
      adapter,
      new PostgresAICallAuditStore(database)
    );
    const result = await runWithPostgresTenantScope(scope, () =>
      gateway.invoke({
        request: request(id, false),
        payload: "x",
        outputSchema,
        budget: budget(),
        killSwitches: [{
          id: "openrouter-staging-kill",
          scopeType: "provider",
          scopeId: "openrouter",
          enabled: true,
          reason: "staging acceptance",
          activatedAt: new Date(Date.now() - 1_000).toISOString(),
          activatedBy: "staging-acceptance"
        }]
      })
    );
    expect(result).toMatchObject({
      kind: "unavailable",
      reason: "NO_ELIGIBLE_MODEL",
      audit: { failureClass: "NO_ELIGIBLE_MODEL" }
    });
    expect(calls).toBe(0);
    record("kill-switch", "local-policy");
  });
});
