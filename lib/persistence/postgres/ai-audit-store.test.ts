import { describe, expect, it } from "vitest";
import {
  PostgresAICallAuditStore,
  PostgresAIGatewayEvidenceStore,
  createAIGatewayCanaryEvidence,
  createAIGatewayRuntimeConfigEvidence
} from "@/lib/persistence/postgres/ai-audit-store";
import {
  PRODUCTION_MODEL_PROFILES,
  PRODUCTION_MODEL_ROUTING_POLICY
} from "@/lib/ai-gateway/production-config";

describe("Postgres AI audit persistence", () => {
  it("persists call audit and per-attempt usage/cost records idempotently with explicit evidence columns", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db = {
      query: async (sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        return { rows: [], rowCount: 1 } as never;
      }
    };
    const store = new PostgresAICallAuditStore(db);
    await store.appendAudit({
      requestId: "request",
      correlationId: "correlation",
      portfolioId: "portfolio",
      companyId: "company",
      environment: "production",
      role: "STANDARD",
      routingPolicyVersion: "2026-09-22.1",
      selectedProfileId: "openrouter-luna",
      actualProfileId: "openrouter-luna",
      gatewayId: "openrouter",
      providerId: "openrouter",
      modelId: "openai/gpt-5.6-luna",
      fallbackUsed: false,
      latencyMs: 42,
      inputTokens: 10,
      outputTokens: 2,
      estimatedCostCents: 1,
      actualCostCents: 0.8,
      validationStatus: "valid",
      recordedAt: "2026-09-22T12:00:00Z",
      auditHash: "audit-hash"
    });
    await store.appendUsage({
      requestId: "request",
      correlationId: "correlation",
      portfolioId: "portfolio",
      companyId: "company",
      environment: "production",
      attempt: 1,
      profileId: "openrouter-luna",
      gatewayId: "openrouter",
      providerId: "openrouter",
      modelId: "openai/gpt-5.6-luna",
      inputTokens: 10,
      outputTokens: 2,
      estimatedCostCents: 1,
      actualCostCents: 0.8,
      latencyMs: 42,
      outcome: "valid",
      recordedAt: "2026-09-22T12:00:00Z",
      usageHash: "usage-hash"
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toContain("routing_policy_version");
    expect(calls[0]!.sql).toContain("model_id");
    expect(calls[0]!.sql).toContain("latency_ms");
    expect(calls[0]!.sql).toContain("ON CONFLICT (audit_hash) DO NOTHING");
    expect(calls[1]!.sql).toContain("correlation_id");
    expect(calls[1]!.sql).toContain("latency_ms");
    expect(calls[1]!.sql).toContain("ON CONFLICT (usage_hash) DO NOTHING");
  });

  it("hashes and persists immutable routing configuration and live canary evidence", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const db = {
      query: async (sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        return { rows: [], rowCount: 1 } as never;
      }
    };
    const config = createAIGatewayRuntimeConfigEvidence({
      configVersion: "2026-09-22.1",
      routingPolicyVersion: "2026-09-22.1",
      providerId: "openrouter",
      profiles: PRODUCTION_MODEL_PROFILES,
      policy: PRODUCTION_MODEL_ROUTING_POLICY,
      recordedAt: "2026-09-22T12:00:00Z"
    });
    const canary = createAIGatewayCanaryEvidence({
      canaryId: "canary-1",
      configHash: config.configHash,
      gatewayId: "openrouter",
      providerId: "openrouter",
      modelId: "openai/gpt-5.6-luna",
      ok: true,
      latencyMs: 50,
      observedAt: "2026-09-22T12:00:01Z"
    });
    const store = new PostgresAIGatewayEvidenceStore(db);
    await store.putConfig(config);
    await store.putCanary(canary);

    expect(config.configHash).toMatch(/^[a-f0-9]{64}$/);
    expect(canary.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(calls[0]!.sql).toContain("ai_gateway_runtime_configs");
    expect(calls[1]!.sql).toContain("ai_gateway_canary_runs");
    expect(calls[1]!.values).toContain("openai/gpt-5.6-luna");
  });
});
