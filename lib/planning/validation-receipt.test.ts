import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { CURRENT_POLICY_VERSION } from "@/lib/domain/policy-registry";
import { validPlan } from "@/lib/planning/test-fixture";
import {
  attestationFor,
  fixtureNow,
  receiptFor,
  validationPolicyFor
} from "@/lib/planning/test-security-fixture";
import { attestPlanValidation } from "@/lib/planning/plan-validator";
import {
  assertValidationReceipt,
  createValidationReceipt,
  createValidationSnapshot
} from "@/lib/planning/validation-receipt";

describe("plan validation receipt", () => {
  it("binds a real validator attestation to the exact plan and registry snapshot", () => {
    const plan = validPlan();
    const receipt = receiptFor(plan);

    expect(assertValidationReceipt(receipt, plan, fixtureNow.getTime()).planId).toBe(plan.id);
    expect(receipt.validationHash).toHaveLength(64);
    expect(receipt.validatorAttestationHash).toHaveLength(64);
    expect(receipt.validationPolicyHash).toHaveLength(64);
    expect(receipt.snapshot.policyRulesHash).toHaveLength(64);
    expect(receipt.snapshot.environmentConfigurationHash).toHaveLength(64);
    expect(receipt.snapshot.evidenceStatus).toEqual({
      health: "not-applicable",
      capacity: "not-applicable",
      credentials: "not-applicable"
    });
  });

  it("rejects a mutated plan after validation", () => {
    const plan = validPlan();
    const receipt = receiptFor(plan);
    const mutated = {
      ...plan,
      steps: [{ ...plan.steps[0], reason: "mutated after validation" }]
    };

    expect(() =>
      assertValidationReceipt(receipt, mutated, fixtureNow.getTime())
    ).toThrow();
  });

  it("rejects tampered and expired receipts", () => {
    const plan = validPlan();
    const receipt = receiptFor(plan);

    expect(() =>
      assertValidationReceipt({
        ...receipt,
        totalStepCostCents: receipt.totalStepCostCents + 1
      }, plan, fixtureNow.getTime())
    ).toThrow();

    expect(() =>
      assertValidationReceipt(
        receipt,
        plan,
        Date.parse("2026-09-20T18:32:00Z")
      )
    ).toThrow();
  });

  it("requires declared validation evidence and authoritative environment hashing", () => {
    const plan = validPlan();
    const healthHash = sha256Hex("health");
    const snapshot = createValidationSnapshot({
      id: "snapshot-required-evidence",
      policyVersion: CURRENT_POLICY_VERSION,
      environment: plan.scope.environment,
      configurationVersion: "config-v1",
      evidenceRequirements: {
        health: "required",
        capacity: "not-applicable",
        credentials: "not-applicable"
      },
      healthReference: {
        id: "health-1",
        version: "1",
        hash: healthHash,
        observedAt: "2026-09-20T18:28:00Z",
        expiresAt: "2026-09-20T18:35:00Z"
      },
      createdAt: "2026-09-20T18:29:00Z"
    });

    expect(snapshot.evidenceStatus.health).toBe("provided");
    expect(snapshot.environmentConfigurationHash).toBe(
      sha256Hex({
        environment: plan.scope.environment,
        configurationVersion: "config-v1"
      })
    );

    expect(() =>
      createValidationSnapshot({
        id: "snapshot-missing-health",
        policyVersion: CURRENT_POLICY_VERSION,
        environment: plan.scope.environment,
        configurationVersion: "config-v1",
        evidenceRequirements: {
          health: "required",
          capacity: "not-applicable",
          credentials: "not-applicable"
        },
        createdAt: "2026-09-20T18:29:00Z"
      })
    ).toThrow();
  });

  it("does not allow owner-decision validation to masquerade as clean validation", () => {
    const basePlan = validPlan();
    const plan = {
      ...basePlan,
      steps: [{
        ...basePlan.steps[0],
        risk: {
          ...basePlan.steps[0].risk,
          level: "medium" as const
        }
      }]
    };
    const snapshot = createValidationSnapshot({
      id: "snapshot-owner-decision",
      policyVersion: CURRENT_POLICY_VERSION,
      environment: plan.scope.environment,
      configurationVersion: "config-v1",
      evidenceRequirements: {
        health: "not-applicable",
        capacity: "not-applicable",
        credentials: "not-applicable"
      },
      createdAt: "2026-09-20T18:29:00Z"
    });

    const attestation = attestPlanValidation(
      plan,
      validationPolicyFor(plan, {
        requireRollbackForRiskAtOrAbove: "medium"
      }),
      "2026-09-20T18:29:15Z"
    );

    expect(attestation.status).toBe("owner-decision-required");

    const receipt = createValidationReceipt({
      id: "receipt-owner-decision",
      plan,
      attestation,
      snapshot,
      validatedAt: "2026-09-20T18:29:30Z",
      expiresAt: "2026-09-20T18:31:00Z"
    });

    expect(() =>
      assertValidationReceipt(receipt, plan, fixtureNow.getTime())
    ).toThrow();
  });

  it("rejects forged validator attestation contents", () => {
    const plan = validPlan();
    const attestation = attestationFor(plan);
    const snapshot = createValidationSnapshot({
      id: "snapshot-forged-attestation",
      policyVersion: CURRENT_POLICY_VERSION,
      environment: plan.scope.environment,
      configurationVersion: "config-v1",
      evidenceRequirements: {
        health: "not-applicable",
        capacity: "not-applicable",
        credentials: "not-applicable"
      },
      createdAt: "2026-09-20T18:29:00Z"
    });

    expect(() =>
      createValidationReceipt({
        id: "receipt-forged",
        plan,
        attestation: {
          ...attestation,
          totalStepCostCents: attestation.totalStepCostCents + 1
        },
        snapshot,
        validatedAt: "2026-09-20T18:29:30Z",
        expiresAt: "2026-09-20T18:31:00Z"
      })
    ).toThrow();
  });
});
