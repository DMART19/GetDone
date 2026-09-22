import { describe, expect, it } from "vitest";
import { PostgresAICallAuditStore } from "@/lib/persistence/postgres/ai-audit-store";

describe("Postgres AI audit persistence", () => {
  it("persists call audit and per-attempt usage/cost records idempotently", async () => {
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
      routingPolicyVersion: "1.0.0",
      fallbackUsed: false,
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
      profileId: "standard",
      gatewayId: "openrouter",
      providerId: "openrouter",
      modelId: "openai/gpt-5.4",
      inputTokens: 10,
      outputTokens: 2,
      estimatedCostCents: 1,
      actualCostCents: 0.8,
      latencyMs: 10,
      outcome: "valid",
      recordedAt: "2026-09-22T12:00:00Z",
      usageHash: "usage-hash"
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toContain("ON CONFLICT (audit_hash) DO NOTHING");
    expect(calls[1]!.sql).toContain("ON CONFLICT (usage_hash) DO NOTHING");
  });
});
