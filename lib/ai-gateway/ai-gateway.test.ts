import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  AIAdapterRequest,
  AICallAuditRecord,
  AIRequestEnvelope,
  AIUsageRecord,
  ModelProfile,
  ModelRoutePolicy
} from "@/lib/ai-gateway/contracts";
import { AIGateway } from "@/lib/ai-gateway/gateway";
import { DevelopmentMockAIGatewayAdapter } from "@/lib/ai-gateway/development-mock-adapter";
import {
  assertRouteDecisionIntegrity,
  evaluateModelEligibility,
  routeAIRequest
} from "@/lib/ai-gateway/router";

const scope = {
  userId: "owner",
  portfolioId: "portfolio",
  companyId: "company",
  environment: "development" as const
};

const baseProfile: ModelProfile = {
  id: "standard-a",
  gatewayId: "mock-gateway",
  providerId: "mock-provider",
  modelId: "mock-model-a",
  enabled: true,
  validationStatus: "validated",
  roles: ["STANDARD", "VISION", "CODING"],
  modalities: ["text", "image"],
  supportsTools: true,
  supportsStructuredOutput: true,
  maxContextTokens: 128000,
  allowedDataClasses: ["PUBLIC", "INTERNAL"],
  allowedEnvironments: ["development"],
  health: "healthy",
  latencyClass: "standard",
  inputCostPerMillionTokensCents: 10,
  outputCostPerMillionTokensCents: 20,
  profileVersion: "1.0.0"
};

const secondProfile: ModelProfile = {
  ...baseProfile,
  id: "standard-b",
  modelId: "mock-model-b"
};

const policy: ModelRoutePolicy = {
  version: "1.0.0",
  routes: {
    STANDARD: ["standard-a", "standard-b"],
    VISION: ["standard-a"],
    CODING: ["standard-a", "standard-b"]
  }
};

function request(overrides: Partial<AIRequestEnvelope["requirements"]> = {}): AIRequestEnvelope {
  return {
    id: "ai-request",
    correlationId: "correlation",
    scope,
    inputHash: "a".repeat(64),
    requestedAt: "2026-09-20T22:00:00Z",
    requirements: {
      role: "STANDARD",
      requiredModalities: ["text"],
      requiresTools: false,
      requiresStructuredOutput: true,
      minimumContextTokens: 32000,
      estimatedInputTokens: 1000,
      expectedOutputTokens: 500,
      dataClass: "INTERNAL",
      environment: "development",
      latencyClass: "standard",
      maxCostCents: 10,
      allowFallback: true,
      ...overrides
    }
  };
}

const budget = {
  portfolioId: "portfolio",
  companyId: "company",
  period: "2026-09",
  companyRemainingCents: 1000,
  portfolioRemainingCents: 1000,
  activeConcurrentCalls: 0,
  concurrencyLimit: 4,
  snapshotAt: "2026-09-20T21:59:00Z",
  expiresAt: "2026-09-20T22:10:00Z"
};

describe("Phase 13 deterministic AI Gateway", () => {
  it("filters models deterministically before preference routing", () => {
    const textOnly = { ...baseProfile, id: "text-only", modalities: ["text"] as const };
    const result = evaluateModelEligibility(textOnly, request({
      role: "VISION",
      requiredModalities: ["image"]
    }));
    expect(result.eligible).toBe(false);
    expect(result.rejectionReasons).toContain("modality-not-supported:image");
  });

  it("does not route unvalidated or environment-ineligible profiles", () => {
    const bad = {
      ...baseProfile,
      validationStatus: "unvalidated" as const,
      allowedEnvironments: ["staging"] as const
    };
    const result = evaluateModelEligibility(bad, request());
    expect(result.rejectionReasons).toEqual(
      expect.arrayContaining(["profile-not-validated", "environment-not-allowed"])
    );
  });

  it("supports ordered fallback only among already eligible profiles", () => {
    const route = routeAIRequest({
      request: request(),
      profiles: [baseProfile, secondProfile],
      policy,
      decidedAt: "2026-09-20T22:00:00Z"
    });
    expect(route.kind).toBe("model");
    expect(route.selectedProfileId).toBe("standard-a");
    expect(route.fallbackProfileIds).toEqual(["standard-b"]);
  });

  it("fails safely with NO_ELIGIBLE_MODEL rather than weakening requirements", async () => {
    const gateway = new AIGateway([{ ...baseProfile, supportsStructuredOutput: false }], policy);
    const result = await gateway.invoke({
      request: request(),
      payload: { prompt: "x" },
      outputSchema: z.object({ answer: z.string() }),
      budget,
      now: "2026-09-20T22:00:00Z"
    });
    expect(result).toMatchObject({ kind: "unavailable", reason: "NO_ELIGIBLE_MODEL" });
  });

  it("never invokes an adapter for DETERMINISTIC work", async () => {
    const adapter = new DevelopmentMockAIGatewayAdapter(() => ({ answer: "unused" }));
    const spy = vi.spyOn(adapter, "invoke");
    const gateway = new AIGateway([baseProfile], policy, adapter);
    await expect(gateway.invoke({
      request: request({ role: "DETERMINISTIC" }),
      payload: {},
      outputSchema: z.object({ answer: z.string() }),
      budget,
      now: "2026-09-20T22:00:00Z"
    })).rejects.toThrow(/must not invoke/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects malformed model output and can use an eligible fallback", async () => {
    const adapter = new DevelopmentMockAIGatewayAdapter((call) =>
      call.profile.id === "standard-a" ? { bad: true } : { answer: "ok" }
    );
    const gateway = new AIGateway([baseProfile, secondProfile], policy, adapter);
    const result = await gateway.invoke({
      request: request(),
      payload: { prompt: "x" },
      outputSchema: z.object({ answer: z.string() }),
      budget,
      now: "2026-09-20T22:00:00Z"
    });
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.output.answer).toBe("ok");
      expect(result.audit.fallbackUsed).toBe(true);
      expect(result.audit.modelId).toBe("mock-model-b");
    }
  });

  it("honors provider kill switches before model selection", () => {
    const route = routeAIRequest({
      request: request(),
      profiles: [baseProfile],
      policy,
      killSwitches: [{
        id: "provider-off",
        scopeType: "provider",
        scopeId: "mock-provider",
        enabled: true,
        reason: "maintenance",
        activatedAt: "2026-09-20T21:00:00Z",
        activatedBy: "owner"
      }],
      decidedAt: "2026-09-20T22:00:00Z"
    });
    expect(route.kind).toBe("no-eligible-model");
    expect(route.rejected["standard-a"]).toContain("kill-switch:provider-off");
  });

  it("blocks calls when concurrency or budget snapshots fail closed", async () => {
    const adapter = new DevelopmentMockAIGatewayAdapter(() => ({ answer: "ok" }));
    const gateway = new AIGateway([baseProfile], policy, adapter);
    await expect(gateway.invoke({
      request: request(),
      payload: {},
      outputSchema: z.object({ answer: z.string() }),
      budget: { ...budget, activeConcurrentCalls: 4 },
      now: "2026-09-20T22:00:00Z"
    })).rejects.toThrow(/concurrency/i);
  });
  it("returns SCHEMA_INVALID when the final eligible model returns malformed output", async () => {
    const adapter = new DevelopmentMockAIGatewayAdapter(() => ({ malformed: true }));
    const gateway = new AIGateway([baseProfile], policy, adapter);
    const result = await gateway.invoke({
      request: request({ allowFallback: false }),
      payload: { prompt: "x" },
      outputSchema: z.object({ answer: z.string() }),
      budget,
      now: "2026-09-20T22:00:00Z"
    });
    expect(result).toMatchObject({ kind: "unavailable", reason: "SCHEMA_INVALID" });
    expect(result.audit.failureClass).toBe("SCHEMA_INVALID");
  });

  it("returns MODEL_IDENTITY_MISMATCH when provider identity differs from the selected profile", async () => {
    const adapter = {
      id: "identity-mismatch",
      version: "1.0.0",
      async invoke() {
        return {
          profileId: "wrong-profile",
          gatewayId: baseProfile.gatewayId,
          providerId: baseProfile.providerId,
          modelId: baseProfile.modelId,
          output: { answer: "should not be trusted" },
          inputTokens: 10,
          outputTokens: 10,
          latencyMs: 1,
          observedAt: "2026-09-20T22:00:00Z"
        };
      }
    };
    const gateway = new AIGateway([baseProfile], policy, adapter);
    const result = await gateway.invoke({
      request: request({ allowFallback: false }),
      payload: { prompt: "x" },
      outputSchema: z.object({ answer: z.string() }),
      budget,
      now: "2026-09-20T22:00:00Z"
    });
    expect(result).toMatchObject({ kind: "unavailable", reason: "MODEL_IDENTITY_MISMATCH" });
  });

  it("returns MODEL_CALL_FAILED when the final adapter invocation throws", async () => {
    const adapter = {
      id: "throwing-adapter",
      version: "1.0.0",
      async invoke(): Promise<never> {
        throw new Error("provider transport failed");
      }
    };
    const gateway = new AIGateway([baseProfile], policy, adapter);
    const result = await gateway.invoke({
      request: request({ allowFallback: false }),
      payload: { prompt: "x" },
      outputSchema: z.object({ answer: z.string() }),
      budget,
      now: "2026-09-20T22:00:00Z"
    });
    expect(result).toMatchObject({ kind: "unavailable", reason: "MODEL_CALL_FAILED" });
  });

  it("routes across gateway adapters and durably records every fallback attempt and cost", async () => {
    const primary = {
      id: "primary-gateway",
      version: "1.0.0",
      async invoke(call: AIAdapterRequest) {
        return {
          profileId: call.profile.id,
          gatewayId: "primary-gateway",
          providerId: "primary-provider",
          modelId: call.profile.modelId,
          output: { malformed: true },
          inputTokens: 20,
          outputTokens: 5,
          providerCostCents: 0.75,
          latencyMs: 10,
          observedAt: "2026-09-20T22:00:00Z"
        };
      }
    };
    const fallback = {
      id: "fallback-gateway",
      version: "1.0.0",
      async invoke(call: AIAdapterRequest) {
        return {
          profileId: call.profile.id,
          gatewayId: "fallback-gateway",
          providerId: "fallback-provider",
          modelId: call.profile.modelId,
          output: { answer: "ok" },
          inputTokens: 10,
          outputTokens: 2,
          providerCostCents: 0.25,
          latencyMs: 5,
          observedAt: "2026-09-20T22:00:00Z"
        };
      }
    };
    const profiles: ModelProfile[] = [
      { ...baseProfile, id: "primary", gatewayId: "primary-gateway", providerId: "primary-provider" },
      { ...secondProfile, id: "fallback", gatewayId: "fallback-gateway", providerId: "fallback-provider" }
    ];
    const usages: AIUsageRecord[] = [];
    const audits: AICallAuditRecord[] = [];
    const gateway = new AIGateway(
      profiles,
      { version: "multi", routes: { STANDARD: ["primary", "fallback"] } },
      [primary, fallback],
      {
        appendUsage: async (record) => { usages.push(record); },
        appendAudit: async (record) => { audits.push(record); }
      }
    );
    const result = await gateway.invoke({
      request: request(),
      payload: { prompt: "x" },
      outputSchema: z.object({ answer: z.string() }),
      budget,
      now: "2026-09-20T22:00:00Z"
    });
    expect(result).toMatchObject({
      kind: "success",
      audit: { fallbackUsed: true, actualCostCents: 1 }
    });
    expect(usages).toMatchObject([
      { attempt: 1, outcome: "schema-invalid", actualCostCents: 0.75 },
      { attempt: 2, outcome: "valid", actualCostCents: 0.25 }
    ]);
    expect(audits).toHaveLength(1);
  });

  it("exercises the full hard-eligibility rejection surface and route integrity checks", () => {
    const rejectedProfile: ModelProfile = {
      ...baseProfile,
      id: "rejected-profile",
      enabled: false,
      validationStatus: "failed",
      health: "degraded",
      roles: ["CODING"],
      modalities: ["text"],
      supportsTools: false,
      supportsStructuredOutput: false,
      maxContextTokens: 1,
      allowedDataClasses: ["PUBLIC"],
      allowedEnvironments: ["staging"],
      latencyClass: "high",
      inputCostPerMillionTokensCents: 1_000_000,
      outputCostPerMillionTokensCents: 1_000_000
    };
    const hardRequest = request({
      role: "VISION",
      requiredModalities: ["image"],
      requiresTools: true,
      requiresStructuredOutput: true,
      minimumContextTokens: 64_000,
      dataClass: "INTERNAL",
      environment: "development",
      latencyClass: "low",
      maxCostCents: 0,
      excludedProfileIds: ["rejected-profile"],
      pinnedProfileIds: ["another-profile"]
    });
    const eligibility = evaluateModelEligibility(rejectedProfile, hardRequest, [{
      id: "provider-block",
      scopeType: "provider",
      scopeId: rejectedProfile.providerId,
      enabled: true,
      reason: "test",
      activatedAt: "2026-09-20T21:00:00Z",
      activatedBy: "owner"
    }]);

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.rejectionReasons).toEqual(expect.arrayContaining([
      "profile-disabled",
      "profile-not-validated",
      "profile-not-healthy",
      "role-not-supported",
      "modality-not-supported:image",
      "tools-not-supported",
      "structured-output-not-supported",
      "context-window-too-small",
      "data-class-not-allowed",
      "environment-not-allowed",
      "latency-class-too-slow",
      "profile-excluded",
      "profile-not-pinned",
      "estimated-cost-exceeds-ceiling",
      "kill-switch:provider-block"
    ]));

    expect(() => evaluateModelEligibility(baseProfile, request({ maxCostCents: -1 }))).toThrow(/non-negative/);

    const missing = routeAIRequest({
      request: request(),
      profiles: [],
      policy: { version: "missing-profile-policy", routes: { STANDARD: ["missing"] } },
      decidedAt: "2026-09-20T22:00:00Z"
    });
    expect(missing.kind).toBe("no-eligible-model");
    expect(missing.rejected.missing).toEqual(["profile-not-found"]);

    const valid = routeAIRequest({
      request: request({ allowFallback: false }),
      profiles: [baseProfile, secondProfile],
      policy,
      decidedAt: "2026-09-20T22:00:00Z"
    });
    expect(valid.fallbackProfileIds).toEqual([]);
    expect(assertRouteDecisionIntegrity(valid)).toBe(valid);
    expect(() => assertRouteDecisionIntegrity({ ...valid, decidedAt: "2026-09-20T22:00:01Z" }))
      .toThrow(/integrity/i);
    expect(() => routeAIRequest({
      request: request(),
      profiles: [baseProfile],
      policy,
      decidedAt: "not-a-time"
    })).toThrow(/decision time/i);
  });

});
