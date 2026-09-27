import { describe, expect, it, vi } from "vitest";
import type { AIGateway } from "@/lib/ai-gateway/gateway";
import { OrchestrationContextBuilder } from "@/lib/orchestration/context-builder";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import {
  GovernedPlanningStageHandler,
  StaticOrchestrationValidationPolicyProvider,
  type OrchestrationPolicyDynamicEvidence,
  type OrchestrationPolicyEvidenceProvider,
  type OrchestrationValidationPolicyProvider
} from "@/lib/orchestration/governed-planning-stage-handler";
import { AIGatewayGovernedPlanner } from "@/lib/orchestration/governed-planner";
import type { OrchestrationPlanningArtifactStore } from "@/lib/orchestration/planning-artifact-store";
import type {
  GovernedPlanArtifact,
  OrchestrationContextSnapshot,
  OrchestrationPlanningArtifact,
  OrchestrationPlanningArtifactKind,
  PlanValidationArtifact,
  PolicyBundleArtifact
} from "@/lib/orchestration/planning-artifacts";
import { validPlan } from "@/lib/planning/test-fixture";
import type { PlanProposal } from "@/lib/planning/plan-schema";

const fixedNow = new Date("2026-09-27T20:00:00.000Z");

function run(state: OrchestrationRun["state"]): OrchestrationRun {
  return Object.freeze({
    id: "orchestration:owner-intent:intent-1",
    correlationId: "corr-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging",
    authorityUserId: "user-a",
    initiatingActor: Object.freeze({ type: "user" as const, id: "user-a" }),
    source: Object.freeze({ kind: "owner-intent" as const, ownerIntentId: "intent-1" }),
    state,
    attempt: 1,
    version: 1,
    availableAt: fixedNow.toISOString(),
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString()
  });
}

function ownerPlan(overrides: Partial<PlanProposal> = {}) {
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
    createdAt: fixedNow.toISOString(),
    ...overrides
  });
}

function aiSuccess(output: PlanProposal) {
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
      decidedAt: fixedNow.toISOString(),
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
      recordedAt: fixedNow.toISOString(),
      auditHash: "a".repeat(64)
    }
  };
}

class MemoryArtifactStore implements OrchestrationPlanningArtifactStore {
  readonly values: OrchestrationPlanningArtifact[] = [];

  async append(_run: OrchestrationRun, artifact: OrchestrationPlanningArtifact) {
    const id = artifact.value.id;
    const existing = this.values.find((item) => item.value.id === id);
    if (existing) return { created: false };
    this.values.push(artifact);
    return { created: true };
  }

  private latest(kind: OrchestrationPlanningArtifactKind) {
    return [...this.values].reverse().find((item) => item.kind === kind) ?? null;
  }

  async latestContext(): Promise<OrchestrationContextSnapshot | null> {
    const value = this.latest("context-snapshot");
    return value?.kind === "context-snapshot" ? value.value : null;
  }

  async latestPlan(): Promise<GovernedPlanArtifact | null> {
    const value = this.latest("plan-proposal");
    return value?.kind === "plan-proposal" ? value.value : null;
  }

  async latestValidation(): Promise<PlanValidationArtifact | null> {
    const value = this.latest("validation-attestation");
    return value?.kind === "validation-attestation" ? value.value : null;
  }

  async latestPolicy(): Promise<PolicyBundleArtifact | null> {
    const value = this.latest("policy-bundle");
    return value?.kind === "policy-bundle" ? value.value : null;
  }

  async count(_run: OrchestrationRun, kind: OrchestrationPlanningArtifactKind) {
    return this.values.filter((item) => item.kind === kind).length;
  }
}

function policyEvidence(
  overrides: Partial<OrchestrationPolicyDynamicEvidence> = {}
): OrchestrationPolicyEvidenceProvider {
  return {
    load: async () => ({
      kind: "ready" as const,
      evidence: {
        region: "us-west",
        killSwitches: [],
        credentialRequirementIds: [],
        fallbackAvailable: true,
        ...overrides
      }
    })
  };
}

function harness(
  output: PlanProposal,
  evidence: OrchestrationPolicyEvidenceProvider = policyEvidence(),
  validationOverride?: OrchestrationValidationPolicyProvider
) {
  const artifacts = new MemoryArtifactStore();
  const contextBuilder = new OrchestrationContextBuilder({
    load: async () => ({
      kind: "ready" as const,
      context: {
        items: [{
          id: "owner-input:intent-1",
          kind: "fact" as const,
          portfolioId: "portfolio-a",
          companyId: "company-a",
          source: "owner-intent",
          provenance: "owner-intent:intent-1",
          observedAt: "2026-09-27T19:59:00.000Z",
          freshnessSeconds: 3600,
          sensitivity: "internal" as const,
          content: "Inspect the repository."
        }],
        scope: {
          portfolioId: "portfolio-a",
          companyId: "company-a",
          allowedSensitivity: ["internal" as const]
        }
      }
    })
  }, () => fixedNow);

  const invoke = vi.fn(async () => aiSuccess(output));
  const planner = new AIGatewayGovernedPlanner(
    { invoke } as unknown as AIGateway,
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
    () => fixedNow
  );

  const validation = validationOverride ?? new StaticOrchestrationValidationPolicyProvider({
    allowedEnvironments: ["staging"],
    allowedDataClasses: ["internal"],
    allowedRegions: ["us-west"],
    maxPlanCostCents: 500,
    maxStepCostCents: 300,
    minimumReliabilityTier: "standard",
    fallbackRequiredForProduction: true,
    fallbackRequiredForCustomerData: true,
    requireRollbackForRiskAtOrAbove: "high",
    availableCredentialBindings: true
  });

  const handler = new GovernedPlanningStageHandler(
    artifacts,
    contextBuilder,
    planner,
    validation,
    evidence,
    () => fixedNow
  );

  return { handler, artifacts, invoke };
}

async function throughValidation(
  handler: GovernedPlanningStageHandler
) {
  await handler.advance(run("context-building"));
  await handler.advance(run("planning"));
  return handler.advance(run("validating"));
}

describe("GovernedPlanningStageHandler", () => {
  it("drives OwnerIntent through context, proposal, validation and AUTO policy without authorizing work", async () => {
    const { handler, artifacts, invoke } = harness(ownerPlan());

    await expect(handler.advance(run("received"))).resolves.toMatchObject({
      state: "context-building",
      wake: "immediate"
    });
    await expect(handler.advance(run("context-building"))).resolves.toMatchObject({
      state: "planning",
      wake: "immediate"
    });
    await expect(handler.advance(run("planning"))).resolves.toMatchObject({
      state: "validating",
      wake: "immediate"
    });
    await expect(handler.advance(run("validating"))).resolves.toMatchObject({
      state: "policy-evaluation",
      wake: "immediate"
    });
    await expect(handler.advance(run("policy-evaluation"))).resolves.toMatchObject({
      state: "policy-cleared",
      wake: "external",
      reason: "policy-cleared-without-authorization-grant"
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(await artifacts.count(run("policy-cleared"), "context-snapshot")).toBe(1);
    expect(await artifacts.count(run("policy-cleared"), "plan-proposal")).toBe(1);
    expect(await artifacts.count(run("policy-cleared"), "validation-attestation")).toBe(1);
    expect(await artifacts.count(run("policy-cleared"), "policy-bundle")).toBe(1);
    expect((await artifacts.latestPolicy(run("policy-cleared")))?.strongestDisposition).toBe("AUTO");
    expect((await artifacts.latestPolicy(run("policy-cleared")))?.authorityApplied).toBe(false);
  });

  it("moves invalid plans to replan-required without policy evaluation", async () => {
    const base = ownerPlan();
    const invalid = ownerPlan({
      requestedCapabilities: ["execute_anything"],
      steps: [{
        ...base.steps[0],
        capabilityRequests: [{ capability: "execute_anything", input: {} }]
      }]
    });
    const { handler, artifacts } = harness(invalid);

    await handler.advance(run("context-building"));
    await handler.advance(run("planning"));
    await expect(handler.advance(run("validating"))).resolves.toMatchObject({
      state: "replan-required",
      wake: "external"
    });
    expect(await artifacts.latestPolicy(run("replan-required"))).toBeNull();
  });

  it("stops approval capabilities at awaiting-approval and does not treat missing proof as authorization", async () => {
    const base = ownerPlan();
    const approvalPlan = ownerPlan({
      requestedCapabilities: ["email.send"],
      steps: [{
        ...base.steps[0],
        capabilityRequests: [{
          capability: "email.send",
          input: {
            companyId: "company-a",
            to: ["owner@example.com"],
            cc: [],
            subject: "Status",
            text: "Ready for review."
          }
        }],
        risk: {
          level: "medium",
          summary: "Outbound customer communication",
          blastRadius: "single-object"
        }
      }]
    });
    const { handler, artifacts } = harness(approvalPlan);

    await throughValidation(handler);
    await expect(handler.advance(run("policy-evaluation"))).resolves.toMatchObject({
      state: "awaiting-approval",
      wake: "external"
    });
    const bundle = await artifacts.latestPolicy(run("awaiting-approval"));
    expect(bundle?.strongestDisposition).toBe("APPROVAL_REQUIRED");
    expect(bundle?.stepPolicies[0]?.evaluation.readyForTaskGeneration).toBe(false);
  });

  it("requires replan when validation policy drifts after attestation", async () => {
    let reads = 0;
    const validation: OrchestrationValidationPolicyProvider = {
      load: async () => {
        reads += 1;
        return {
          kind: "ready" as const,
          constraints: {
            allowedEnvironments: ["staging"] as const,
            allowedDataClasses: ["internal"] as const,
            allowedRegions: ["us-west"],
            maxPlanCostCents: reads === 1 ? 500 : 499,
            maxStepCostCents: 300,
            minimumReliabilityTier: "standard" as const,
            fallbackRequiredForProduction: true,
            fallbackRequiredForCustomerData: true,
            requireRollbackForRiskAtOrAbove: "high" as const,
            availableCredentialBindings: true
          }
        };
      }
    };
    const { handler } = harness(ownerPlan(), policyEvidence(), validation);

    await throughValidation(handler);
    await expect(handler.advance(run("policy-evaluation"))).resolves.toMatchObject({
      state: "replan-required",
      wake: "external",
      reason: "validation-policy-drift"
    });
  });

  it("persists policy BLOCKED when a trusted kill switch applies", async () => {
    const evidence = policyEvidence({
      killSwitches: [{
        id: "ks-repository",
        scopeType: "capability",
        scopeId: "repository.inspect",
        enabled: true,
        reason: "incident",
        activatedAt: "2026-09-27T19:00:00.000Z",
        activatedBy: "owner"
      }]
    });
    const { handler, artifacts } = harness(ownerPlan(), evidence);

    await throughValidation(handler);
    await expect(handler.advance(run("policy-evaluation"))).resolves.toMatchObject({
      state: "blocked",
      wake: "external",
      reason: "policy-blocked"
    });
    expect((await artifacts.latestPolicy(run("blocked")))?.strongestDisposition).toBe("BLOCKED");
  });

  it("defers rather than guessing when protected-capacity evidence is required but unavailable", async () => {
    const base = ownerPlan();
    const computePlan = ownerPlan({
      steps: [{
        ...base.steps[0],
        resourceRequirements: {
          ...base.steps[0].resourceRequirements,
          compute: { cpuCores: 2 }
        }
      }]
    });
    const { handler } = harness(computePlan);

    await throughValidation(handler);
    await expect(handler.advance(run("policy-evaluation"))).resolves.toMatchObject({
      kind: "defer",
      reason: "protected-capacity-evidence-unavailable:step-1"
    });
  });
});
