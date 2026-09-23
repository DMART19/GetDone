import { describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";
import {
  readOwnerAIGatewayHealth,
  recordAIGatewayCanarySuccess
} from "@/lib/ai-gateway/health.server";

const scope = {
  userId: "owner-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production" as const
};

function result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
  return {
    command: "",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows
  };
}

class FakeHealthDb implements SqlQueryable {
  writes: Array<{ text: string; values?: readonly unknown[] }> = [];

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<R>> {
    this.writes.push({ text, values });

    if (text.includes("entity_type=$1")) {
      return result([{ observed_at: "2026-09-23T08:00:00.000Z" }]) as unknown as QueryResult<R>;
    }
    if (text.includes("failureClass")) {
      return result([{ failure_class: "MODEL_CALL_FAILED" }]) as unknown as QueryResult<R>;
    }
    if (text.includes("actualProfileId")) {
      const profileId = values?.[2];
      return result([{
        recorded_at: profileId === "primary-profile"
          ? "2026-09-23T08:10:00.000Z"
          : "2026-09-23T08:05:00.000Z"
      }]) as unknown as QueryResult<R>;
    }
    if (text.includes("SUM(actual_cost_cents)")) {
      return result([{ spent_cents: "82.5" }]) as unknown as QueryResult<R>;
    }
    if (text.includes("INSERT INTO control_plane_entities")) {
      return result([]) as unknown as QueryResult<R>;
    }
    throw new Error(`Unexpected health query: ${text}`);
  }
}

function configuredEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    OPENROUTER_API_KEY: "server-only-secret-value",
    GETDONE_AI_MONTHLY_COMPANY_BUDGET_CENTS: "100",
    GETDONE_AI_MODEL_PROFILES_JSON: JSON.stringify([
      {
        id: "primary-profile",
        gatewayId: "openrouter",
        providerId: "openrouter",
        modelId: "provider/private-primary-model",
        enabled: true,
        validationStatus: "validated",
        roles: ["STANDARD"],
        modalities: ["text"],
        supportsTools: true,
        supportsStructuredOutput: true,
        maxContextTokens: 128000,
        allowedDataClasses: ["PUBLIC", "INTERNAL"],
        allowedEnvironments: ["production"],
        health: "healthy",
        latencyClass: "standard",
        inputCostPerMillionTokensCents: 1,
        outputCostPerMillionTokensCents: 1,
        profileVersion: "1"
      },
      {
        id: "fallback-profile",
        gatewayId: "openrouter",
        providerId: "openrouter",
        modelId: "provider/private-fallback-model",
        enabled: true,
        validationStatus: "validated",
        roles: ["STANDARD"],
        modalities: ["text"],
        supportsTools: true,
        supportsStructuredOutput: true,
        maxContextTokens: 128000,
        allowedDataClasses: ["PUBLIC", "INTERNAL"],
        allowedEnvironments: ["production"],
        health: "healthy",
        latencyClass: "standard",
        inputCostPerMillionTokensCents: 1,
        outputCostPerMillionTokensCents: 1,
        profileVersion: "1"
      }
    ]),
    GETDONE_AI_ROUTING_POLICY_JSON: JSON.stringify({
      version: "policy-production-7",
      routes: { STANDARD: ["primary-profile", "fallback-profile"] }
    }),
    ...overrides
  };
}

describe("owner-safe AI Gateway health", () => {
  it("returns safe operational state without exposing credentials or model/profile identities", async () => {
    const db = new FakeHealthDb();
    const env = configuredEnv();
    const health = await readOwnerAIGatewayHealth(scope, env, {
      db,
      now: new Date("2026-09-23T09:00:00.000Z")
    });

    expect(health).toEqual({
      surfaceVersion: "1.0.0",
      configured: true,
      status: "ready",
      activeRoutingPolicyVersion: "policy-production-7",
      lastSuccessfulCanaryAt: "2026-09-23T08:00:00.000Z",
      primary: {
        configured: true,
        available: true,
        lastSuccessfulCallAt: "2026-09-23T08:10:00.000Z"
      },
      fallback: {
        configured: true,
        available: true,
        lastSuccessfulCallAt: "2026-09-23T08:05:00.000Z"
      },
      recentErrorClass: "MODEL_CALL_FAILED",
      budget: {
        configured: true,
        status: "near-limit",
        period: "2026-09",
        spentCents: 82.5,
        limitCents: 100,
        remainingCents: 17.5
      }
    });

    const auditReads = db.writes.filter((entry) =>
      entry.text.includes("FROM ai_call_audits")
    );
    expect(auditReads).not.toHaveLength(0);
    for (const read of auditReads) {
      expect(read.text).toContain("portfolio_id=$1");
      expect(read.text).toContain("company_id=$2");
      expect(read.values?.[0]).toBe("portfolio-a");
      expect(read.values?.[1]).toBe("company-a");
    }

    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain("server-only-secret-value");
    expect(serialized).not.toContain("private-primary-model");
    expect(serialized).not.toContain("private-fallback-model");
    expect(serialized).not.toContain("primary-profile");
    expect(serialized).not.toContain("fallback-profile");
    expect(serialized).not.toContain("OPENROUTER_API_KEY");
  });

  it("reports degraded when fallback is unavailable and unknown budget when no ceiling is configured", async () => {
    const db = new FakeHealthDb();
    const profiles = JSON.parse(configuredEnv().GETDONE_AI_MODEL_PROFILES_JSON!);
    profiles[1].health = "degraded";
    const env = configuredEnv({
      GETDONE_AI_MODEL_PROFILES_JSON: JSON.stringify(profiles),
      GETDONE_AI_MONTHLY_COMPANY_BUDGET_CENTS: undefined
    });

    const health = await readOwnerAIGatewayHealth(scope, env, {
      db,
      now: new Date("2026-09-23T09:00:00.000Z")
    });

    expect(health.status).toBe("degraded");
    expect(health.primary.available).toBe(true);
    expect(health.fallback.available).toBe(false);
    expect(health.budget).toMatchObject({
      configured: false,
      status: "unknown",
      limitCents: null,
      remainingCents: null
    });
  });

  it("reports not-configured without exposing configuration parse errors", async () => {
    const db = new FakeHealthDb();
    const health = await readOwnerAIGatewayHealth(scope, {
      OPENROUTER_API_KEY: "secret",
      GETDONE_AI_MODEL_PROFILES_JSON: "{bad-json",
      GETDONE_AI_ROUTING_POLICY_JSON: "{}"
    }, { db, now: new Date("2026-09-23T09:00:00.000Z") });

    expect(health).toMatchObject({
      configured: false,
      status: "not-configured",
      activeRoutingPolicyVersion: null,
      primary: { configured: false, available: false },
      fallback: { configured: false, available: false }
    });
  });

  it("persists only a tenant-scoped safe canary marker", async () => {
    const db = new FakeHealthDb();
    await recordAIGatewayCanarySuccess({
      db,
      scope,
      observedAt: "2026-09-23T08:00:00.000Z"
    });

    const write = db.writes.find((entry) =>
      entry.text.includes("INSERT INTO control_plane_entities")
    );
    expect(write).toBeDefined();
    const serialized = JSON.stringify(write?.values);
    expect(serialized).toContain("portfolio-a");
    expect(serialized).toContain("company-a");
    expect(serialized).toContain("2026-09-23T08:00:00.000Z");
    expect(serialized).not.toContain("model");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("secret");
  });

  it("rejects an invalid canary timestamp before persistence", async () => {
    const db = new FakeHealthDb();
    await expect(recordAIGatewayCanarySuccess({
      db,
      scope,
      observedAt: "not-a-timestamp"
    })).rejects.toThrow(/valid timestamp/);
    expect(db.writes).toHaveLength(0);
  });

  it("reports exhausted budget once tenant spend reaches the configured ceiling", async () => {
    class ExhaustedBudgetDb extends FakeHealthDb {
      override async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[]
      ): Promise<QueryResult<R>> {
        if (text.includes("SUM(actual_cost_cents)")) {
          this.writes.push({ text, values });
          return result([{ spent_cents: "120" }]) as unknown as QueryResult<R>;
        }
        return super.query<R>(text, values);
      }
    }

    const health = await readOwnerAIGatewayHealth(
      scope,
      configuredEnv(),
      {
        db: new ExhaustedBudgetDb(),
        now: new Date("2026-09-23T09:00:00.000Z")
      }
    );
    expect(health.budget).toMatchObject({
      status: "exhausted",
      spentCents: 120,
      limitCents: 100,
      remainingCents: 0
    });
  });

  it("never invokes a provider while reading health", async () => {
    const db = new FakeHealthDb();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await readOwnerAIGatewayHealth(scope, configuredEnv(), {
        db,
        now: new Date("2026-09-23T09:00:00.000Z")
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
