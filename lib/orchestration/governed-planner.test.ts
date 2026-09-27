import { describe, expect, it, vi } from "vitest";
import type { AIGateway } from "@/lib/ai-gateway/gateway";
import { assembleContext } from "@/lib/intelligence/context";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import {
  createContextSnapshot
} from "@/lib/orchestration/planning-artifacts";
import {
  AIGatewayGovernedPlanner
} from "@/lib/orchestration/governed-planner";
import { validPlan } from "@/lib/planning/test-fixture";

const now = new Date("2026-09-27T20:00:00.000Z");

function run(): OrchestrationRun {
  return Object.freeze({
    id: "orchestration:owner-intent:intent-1",
    correlationId: "corr-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging",
    authorityUserId: "user-a",
    initiatingActor: Object.freeze({ type: "user" as const, id: "user-a" }),
    source: Object.freeze({ kind: "owner-intent" as const, ownerIntentId: "intent-1" }),
    state: "planning",
    attempt: 1,
    version: 3,
    availableAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  });
}

function context() {
  const assembled = assembleContext([{
    id: "owner-input:intent-1",
    kind: "fact",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    source: "owner-intent",
    provenance: "owner-intent:intent-1",
    observedAt: "2026-09-27T19:59:00.000Z",
    freshnessSeconds: 3600,
    sensitivity: "internal",
    content: "Inspect the repository."
  }], {
    portfolioId: "portfolio-a",
    companyId: "company-a",
    allowedSensitivity: ["internal"]
  }, { now: now.getTime() });

  return createContextSnapshot({
    id: "context-1",
    runId: run().id,
    correlationId: "corr-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging",
    dataClass: "internal",
    assembled,
    createdAt: now.toISOString()
  });
}

function plan(overrides: Record<string, unknown> = {}) {
  const base = validPlan();
  return validPlan({
    source: { type: "owner-request", requestId: "intent-1" },
    objective: undefined,
    evidence: [{
      id: "owner-input:intent-1",
      kind: "owner-input",
      source: "owner-intent",
      observedAt: "2026-09-27T19:59:00.000Z"
    }],
    steps: [{
      ...base.steps[0],
      evidenceIds: ["owner-input:intent-1"]
    }],
    createdAt: now.toISOString(),
    ...overrides
  });
}

function success(output: unknown) {
  return {
    kind: "success" as const,
    output,
    route: {
      requestId: "request-1",
      routingPolicyVersion: "route-v1",
      kind: "model" as const,
      selectedProfileId: "planner",
      fallbackProfileIds: [],
      eligibleProfileIds: ["planner"],
      rejected: {},
      decidedAt: now.toISOString(),
      decisionHash: "d".repeat(64)
    },
    audit: {
      requestId: "request-1",
      correlationId: "corr-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "staging" as const,
      role: "HIGH_REASONING" as const,
      routingPolicyVersion: "route-v1",
      selectedProfileId: "planner",
      actualProfileId: "planner",
      gatewayId: "openrouter",
      providerId: "openrouter",
      modelId: "test-model",
      fallbackUsed: false,
      latencyMs: 10,
      inputTokens: 100,
      outputTokens: 100,
      estimatedCostCents: 1,
      actualCostCents: 1,
      validationStatus: "valid" as const,
      recordedAt: now.toISOString(),
      auditHash: "a".repeat(64)
    }
  };
}

function planner(output: unknown) {
  const invoke = vi.fn(async () => success(output));
  const gateway = { invoke } as unknown as AIGateway;
  const instance = new AIGatewayGovernedPlanner(
    gateway,
    {
      load: async () => ({
        kind: "ready" as const,
        budget: {
          portfolioId: "portfolio-a",
          companyId: "company-a",
          period: "2026-09",
          companyRemainingCents: 100,
          portfolioRemainingCents: 100,
          activeConcurrentCalls: 0,
          concurrencyLimit: 4,
          snapshotAt: "2026-09-27T19:59:00.000Z",
          expiresAt: "2026-09-27T20:05:00.000Z"
        },
        killSwitches: []
      })
    },
    { maxCostCents: 25 },
    () => now
  );
  return { instance, invoke };
}

describe("AIGatewayGovernedPlanner", () => {
  it("returns a hash-bound proposal artifact without applying authority", async () => {
    const { instance, invoke } = planner(plan());
    const result = await instance.propose(run(), context());
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("expected governed plan");
    expect(result.artifact.plan.source).toEqual({
      type: "owner-request",
      requestId: "intent-1"
    });
    expect(result.artifact.planHash).toHaveLength(64);
    expect(result.artifact.authorityApplied).toBe(false);
    expect(result.artifact.aiAuditHash).toBe("a".repeat(64));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects a model attempt to downgrade context classification", async () => {
    const { instance } = planner(plan({
      scope: {
        portfolioId: "portfolio-a",
        companyId: "company-a",
        environment: "staging",
        dataClass: "public"
      }
    }));
    await expect(instance.propose(run(), context())).rejects.toThrow(/data classification/i);
  });

  it("rejects evidence citations that were not in the persisted context snapshot", async () => {
    const bad = plan({
      evidence: [{
        id: "invented-evidence",
        kind: "research",
        source: "model",
        observedAt: now.toISOString()
      }],
      steps: [{
        ...validPlan().steps[0],
        evidenceIds: ["invented-evidence"]
      }]
    });
    const { instance } = planner(bad);
    await expect(instance.propose(run(), context())).rejects.toThrow(/outside the persisted context/i);
  });

  it("does not call a model when authoritative AI admission evidence is unavailable", async () => {
    const invoke = vi.fn();
    const instance = new AIGatewayGovernedPlanner(
      { invoke } as unknown as AIGateway,
      {
        load: async () => ({
          kind: "unavailable" as const,
          reason: "ai-budget-not-ready",
          retryAt: "2026-09-27T20:01:00.000Z"
        })
      },
      { maxCostCents: 25 },
      () => now
    );

    await expect(instance.propose(run(), context())).resolves.toMatchObject({
      kind: "unavailable",
      reason: "ai-budget-not-ready"
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
