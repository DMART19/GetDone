import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AIRequestEnvelope, ModelProfile, ModelRoutePolicy } from "@/lib/ai-gateway/contracts";
import { AIGateway } from "@/lib/ai-gateway/gateway";
import { DevelopmentMockAIGatewayAdapter } from "@/lib/ai-gateway/development-mock-adapter";
import { evaluateModelEligibility, routeAIRequest } from "@/lib/ai-gateway/router";

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
});
