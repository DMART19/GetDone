import { describe, expect, it } from "vitest";
import {
  createApprovalProof,
  createStepUpProof,
  type ApprovalProof,
  type StepUpProof
} from "@/lib/authorization/proofs";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import { createBudgetReservation } from "@/lib/domain/budget-reservation";
import { createProtectedCapacitySnapshot } from "@/lib/domain/protected-capacity";
import {
  evaluatePolicy,
  evaluateStepPolicy,
  POLICY_ENGINE_VERSION,
  POLICY_RULES_HASH,
  type PolicyEvaluationInput
} from "@/lib/planning/policy-engine";

const now = Date.parse("2026-09-20T18:30:00Z");

const stagingScope = {
  userId: "user-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "staging" as const
};

const productionScope = {
  ...stagingScope,
  environment: "production" as const
};

function approvalProof(
  level: "approval" | "strong-approval",
  scope: TrustedExecutionScope = stagingScope
): ApprovalProof {
  return createApprovalProof({
    id: `proof-${level}`,
    decisionId: "decision-1",
    approvalId: "approval-1",
    actorId: "user-a",
    scope,
    level,
    planHash: "plan-hash",
    stepHash: "step-hash",
    grantedAt: "2026-09-20T18:29:00Z",
    expiresAt: "2026-09-20T18:35:00Z",
    stepUpProofId: level === "strong-approval" ? "stepup-1" : undefined
  });
}

function stepUpProof(): StepUpProof {
  return createStepUpProof({
    id: "stepup-1",
    actorId: "user-a",
    scope: productionScope,
    method: "passkey",
    authenticatedAt: "2026-09-20T18:29:00Z",
    expiresAt: "2026-09-20T18:34:00Z"
  });
}

function input(overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  return {
    authenticated: true,
    scopeResolved: true,
    trustedScope: stagingScope,
    capability: "revenue.read",
    planHash: "plan-hash",
    stepHash: "step-hash",
    environment: "staging",
    dataClass: "internal",
    region: "us-west",
    allowedEnvironments: ["development", "staging"],
    allowedDataClasses: ["public", "internal"],
    allowedRegions: ["us-west"],
    credentialRequirementIds: [],
    fallbackRequired: false,
    fallbackAvailable: true,
    idempotencyKey: "policy-request-12345678",
    killSwitches: [],
    now,
    ...overrides
  };
}

describe("deterministic policy engine", () => {
  it("returns versioned AUTO only when all hard preflight constraints pass", () => {
    const result = evaluatePolicy(input());
    expect(result.disposition).toBe("AUTO");
    expect(result.readyForTaskGeneration).toBe(true);
    expect(result.policyEngineVersion).toBe(POLICY_ENGINE_VERSION);
    expect(result.policyRulesHash).toBe(POLICY_RULES_HASH);
  });

  it("requires a matching hash-bound approval proof for approval capabilities", () => {
    const pending = evaluatePolicy(input({ capability: "email.send" }));
    expect(pending.disposition).toBe("APPROVAL_REQUIRED");
    expect(pending.readyForTaskGeneration).toBe(false);

    const approved = evaluatePolicy(input({
      capability: "email.send",
      approvalProof: approvalProof("approval")
    }));
    expect(approved.readyForTaskGeneration).toBe(true);
  });

  it("requires matching fresh strong approval and step-up proofs", () => {
    const pending = evaluatePolicy(input({
      trustedScope: productionScope,
      capability: "production.deploy",
      environment: "production",
      dataClass: "sensitive",
      allowedEnvironments: ["production"],
      allowedDataClasses: ["sensitive"],
      approvalProof: approvalProof("strong-approval", productionScope)
    }));
    expect(pending.disposition).toBe("STRONG_APPROVAL");
    expect(pending.readyForTaskGeneration).toBe(false);

    const satisfied = evaluatePolicy(input({
      trustedScope: productionScope,
      capability: "production.deploy",
      environment: "production",
      dataClass: "sensitive",
      allowedEnvironments: ["production"],
      allowedDataClasses: ["sensitive"],
      approvalProof: approvalProof("strong-approval", productionScope),
      stepUpProof: stepUpProof()
    }));
    expect(satisfied.readyForTaskGeneration).toBe(true);
  });

  it("BLOCKED outranks approval when any admission-context kill switch applies", () => {
    const result = evaluatePolicy(input({
      capability: "email.send",
      providerId: "provider-a",
      approvalProof: approvalProof("approval"),
      killSwitches: [{
        id: "ks-provider",
        scopeType: "provider",
        scopeId: "provider-a",
        enabled: true,
        reason: "incident",
        activatedAt: "2026-09-20T18:00:00Z",
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
  });

  it("requires a bound budget reservation before budgeted work can be admitted", () => {
    const reservation = createBudgetReservation({
      id: "reservation-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      policyId: "budget-1",
      policyVersion: "budget-v1",
      planHash: "plan-hash",
      stepHash: "step-hash",
      amountCents: 10_000,
      currency: "USD",
      reservedAt: "2026-09-20T18:29:00Z",
      expiresAt: "2026-09-20T18:35:00Z"
    });

    const result = evaluatePolicy(input({
      approvalProof: approvalProof("approval"),
      budgetReservation: reservation,
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
    expect(result.readyForTaskGeneration).toBe(true);
  });

  it("aggregates multi-capability policy using BLOCKED > STRONG > APPROVAL > AUTO", () => {
    const base = input({
      trustedScope: productionScope,
      environment: "production",
      dataClass: "sensitive",
      allowedEnvironments: ["production"],
      allowedDataClasses: ["sensitive"],
      approvalProof: approvalProof("strong-approval", productionScope),
      stepUpProof: stepUpProof()
    });
    const { capability: ignoredCapability, ...stepInput } = base;
    void ignoredCapability;

    const result = evaluateStepPolicy({
      ...stepInput,
      capabilities: ["revenue.read", "production.deploy"]
    });

    expect(result.disposition).toBe("STRONG_APPROVAL");
    expect(result.readyForTaskGeneration).toBe(true);
  });

  it("fails closed for missing idempotency, credentials, fallback or protected headroom", () => {
    const capacitySnapshot = createProtectedCapacitySnapshot({
      id: "capacity-bad",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      capacityClass: "cpu",
      totalUnits: 100,
      committedUnits: 95,
      protectedMinimumFreeUnits: 10,
      requestedUnits: 1,
      observedAt: "2026-09-20T18:29:00Z",
      expiresAt: "2026-09-20T18:35:00Z"
    });

    const result = evaluatePolicy(input({
      idempotencyKey: undefined,
      credentialRequirementIds: ["credential-required"],
      capacitySnapshot,
      fallbackRequired: true,
      fallbackAvailable: false
    }));

    expect(result.disposition).toBe("BLOCKED");
    expect(result.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      "IDEMPOTENCY_MISSING",
      "CREDENTIAL_MISSING",
      "CAPACITY_SNAPSHOT_INVALID",
      "FALLBACK_MISSING"
    ]));
  });
});
