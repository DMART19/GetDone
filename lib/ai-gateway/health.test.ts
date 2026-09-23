import { describe, expect, it } from "vitest";
import {
  budgetEvidenceFromSnapshot,
  buildOwnerSafeAIGatewayHealth
} from "@/lib/ai-gateway/health";

const profiles = [
  {
    id: "primary-secret-profile",
    gatewayId: "openrouter",
    providerId: "openrouter",
    modelId: "provider/primary-secret-model",
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
    inputCostPerMillionTokensCents: 10,
    outputCostPerMillionTokensCents: 20,
    profileVersion: "1"
  },
  {
    id: "fallback-secret-profile",
    gatewayId: "openrouter",
    providerId: "openrouter",
    modelId: "provider/fallback-secret-model",
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
    inputCostPerMillionTokensCents: 10,
    outputCostPerMillionTokensCents: 20,
    profileVersion: "1"
  }
];

const env = {
  OPENROUTER_API_KEY: "super-secret-provider-key",
  GETDONE_AI_MODEL_PROFILES_JSON: JSON.stringify(profiles),
  GETDONE_AI_ROUTING_POLICY_JSON: JSON.stringify({
    version: "policy-prod-7",
    routes: {
      STANDARD: ["primary-secret-profile", "fallback-secret-profile"]
    }
  })
};

const unavailableBudget = budgetEvidenceFromSnapshot(null);

describe("owner-safe AI Gateway health", () => {
  it("reports routing availability without exposing provider credentials or model identities", () => {
    const health = buildOwnerSafeAIGatewayHealth({
      env,
      environment: "production",
      evidence: {
        lastSuccessfulCanaryAt: "2026-09-22T20:00:00Z",
        recentErrorClass: "MODEL_CALL_FAILED",
        budget: unavailableBudget
      },
      checkedAt: new Date("2026-09-22T20:05:00Z")
    });

    expect(health).toEqual({
      configured: true,
      routingPolicyVersion: "policy-prod-7",
      lastSuccessfulCanaryAt: "2026-09-22T20:00:00Z",
      primaryAvailability: "available",
      fallbackAvailability: "available",
      recentErrorClass: "MODEL_CALL_FAILED",
      budget: unavailableBudget,
      checkedAt: "2026-09-22T20:05:00.000Z"
    });

    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain("super-secret-provider-key");
    expect(serialized).not.toContain("primary-secret-profile");
    expect(serialized).not.toContain("fallback-secret-profile");
    expect(serialized).not.toContain("provider/primary-secret-model");
    expect(serialized).not.toContain("provider/fallback-secret-model");
  });

  it("fails closed to configuration-invalid without leaking invalid configuration", () => {
    const health = buildOwnerSafeAIGatewayHealth({
      env: {
        OPENROUTER_API_KEY: "secret",
        GETDONE_AI_MODEL_PROFILES_JSON: "{bad-json",
        GETDONE_AI_ROUTING_POLICY_JSON: "{}"
      },
      environment: "production",
      evidence: {
        lastSuccessfulCanaryAt: null,
        recentErrorClass: "bad value with spaces",
        budget: unavailableBudget
      }
    });
    expect(health).toMatchObject({
      configured: false,
      routingPolicyVersion: null,
      primaryAvailability: "unavailable",
      fallbackAvailability: "unavailable",
      recentErrorClass: "CONFIGURATION_INVALID"
    });
  });

  it("classifies budget snapshots without inventing unavailable budget authority", () => {
    const base = {
      portfolioId: "portfolio-a",
      companyId: "company-a",
      period: "2026-09",
      companyRemainingCents: 100,
      portfolioRemainingCents: 1000,
      activeConcurrentCalls: 1,
      concurrencyLimit: 4,
      snapshotAt: "2026-09-22T20:00:00Z",
      expiresAt: "2026-09-22T21:00:00Z"
    };
    expect(budgetEvidenceFromSnapshot(base, new Date("2026-09-22T20:05:00Z")).state)
      .toBe("healthy");
    expect(budgetEvidenceFromSnapshot(
      { ...base, companyRemainingCents: 0 },
      new Date("2026-09-22T20:05:00Z")
    ).state).toBe("exhausted");
    expect(budgetEvidenceFromSnapshot(
      { ...base, activeConcurrentCalls: 4 },
      new Date("2026-09-22T20:05:00Z")
    ).state).toBe("saturated");
    expect(budgetEvidenceFromSnapshot(
      { ...base, expiresAt: "2026-09-22T20:01:00Z" },
      new Date("2026-09-22T20:05:00Z")
    ).state).toBe("stale");
    expect(unavailableBudget.state).toBe("unavailable");
  });
});
