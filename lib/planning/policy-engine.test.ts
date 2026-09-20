import { describe, expect, it } from "vitest";
import { evaluatePolicy, type PolicyEvaluationInput } from "@/lib/planning/policy-engine";

function input(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    authenticated: true,
    scopeResolved: true,
    trustedScope: {
      portfolioId: "portfolio-a",
      companyId: "company-a"
    },
    capability: "revenue.read",
    environment: "staging",
    dataClass: "internal",
    region: "us-west",
    allowedEnvironments: ["development", "staging"],
    allowedDataClasses: ["public", "internal"],
    allowedRegions: ["us-west"],
    credentialBindingAvailable: true,
    credentialBindingRequired: false,
    protectedHeadroomSatisfied: true,
    fallbackRequired: false,
    fallbackAvailable: true,
    idempotencyKey: "policy-request-123",
    killSwitches: [],
    ...overrides
  };
}

describe("deterministic policy engine", () => {
  it("returns AUTO only when all hard preflight constraints pass", () => {
    const result = evaluatePolicy(input());
    expect(result.disposition).toBe("AUTO");
    expect(result.readyForTaskGeneration).toBe(true);
  });

  it("returns APPROVAL_REQUIRED for approval capabilities until approval exists", () => {
    const pending = evaluatePolicy(input({
      capability: "email.send"
    }));
    expect(pending.disposition).toBe("APPROVAL_REQUIRED");
    expect(pending.readyForTaskGeneration).toBe(false);

    const approved = evaluatePolicy(input({
      capability: "email.send",
      approvalGranted: true
    }));
    expect(approved.readyForTaskGeneration).toBe(true);
  });

  it("requires fresh step-up for STRONG_APPROVAL", () => {
    const pending = evaluatePolicy(input({
      capability: "production.deploy",
      environment: "production",
      dataClass: "sensitive",
      allowedEnvironments: ["production"],
      allowedDataClasses: ["sensitive"],
      approvalGranted: true,
      freshStepUpSatisfied: false
    }));
    expect(pending.disposition).toBe("STRONG_APPROVAL");
    expect(pending.requiresFreshStepUp).toBe(true);
    expect(pending.readyForTaskGeneration).toBe(false);

    const satisfied = evaluatePolicy(input({
      capability: "production.deploy",
      environment: "production",
      dataClass: "sensitive",
      allowedEnvironments: ["production"],
      allowedDataClasses: ["sensitive"],
      approvalGranted: true,
      freshStepUpSatisfied: true
    }));
    expect(satisfied.readyForTaskGeneration).toBe(true);
  });

  it("BLOCKED outranks approval when a kill switch applies", () => {
    const result = evaluatePolicy(input({
      capability: "email.send",
      approvalGranted: true,
      killSwitches: [{
        id: "ks-company",
        scopeType: "company",
        scopeId: "company-a",
        enabled: true,
        reason: "incident",
        activatedAt: "2026-09-20T16:00:00Z",
        activatedBy: "user-a"
      }]
    }));

    expect(result.disposition).toBe("BLOCKED");
    expect(result.readyForTaskGeneration).toBe(false);
    expect(result.reasons.some((reason) => reason.code === "KILL_SWITCH")).toBe(true);
  });

  it("blocks protected guardrail violations", () => {
    const result = evaluatePolicy(input({
      guardrails: {
        policies: [{
          id: "g1",
          scopeId: "company-a",
          metric: "availability",
          operator: "min",
          value: 99.9,
          protected: true
        }],
        metrics: { availability: 98.5 }
      }
    }));

    expect(result.disposition).toBe("BLOCKED");
    expect(result.reasons.some((reason) => reason.code === "GUARDRAIL_BLOCKED")).toBe(true);
  });

  it("turns a budget approval threshold into approval without weakening stronger rules", () => {
    const result = evaluatePolicy(input({
      budget: {
        policy: {
          id: "budget-1",
          scopeId: "company-a",
          currency: "USD",
          period: "monthly",
          hardLimitCents: 100_000,
          approvalThresholdCents: 80_000,
          enabled: true
        },
        currentSpendCents: 75_000,
        requestedCostCents: 10_000
      }
    }));

    expect(result.disposition).toBe("APPROVAL_REQUIRED");
    expect(result.readyForTaskGeneration).toBe(false);
  });

  it("fails closed for missing idempotency, credentials, fallback or protected headroom", () => {
    const result = evaluatePolicy(input({
      idempotencyKey: undefined,
      credentialBindingRequired: true,
      credentialBindingAvailable: false,
      protectedHeadroomSatisfied: false,
      fallbackRequired: true,
      fallbackAvailable: false
    }));

    expect(result.disposition).toBe("BLOCKED");
    expect(result.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      "IDEMPOTENCY_MISSING",
      "CREDENTIAL_MISSING",
      "HEADROOM_BLOCKED",
      "FALLBACK_MISSING"
    ]));
  });
});
