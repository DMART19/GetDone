import { describe, expect, it } from "vitest";
import { validPlan } from "@/lib/planning/test-fixture";
import { cleanValidation, fixtureNow, receiptFor } from "@/lib/planning/test-security-fixture";
import {
  assertValidationReceipt,
  createValidationReceipt,
  createValidationSnapshot
} from "@/lib/planning/validation-receipt";

describe("plan validation receipt", () => {
  it("binds a clean validation result to the exact plan and registry snapshot", () => {
    const plan = validPlan();
    const receipt = receiptFor(plan);
    expect(assertValidationReceipt(receipt, plan, fixtureNow.getTime()).planId).toBe(plan.id);\n    expect(receipt.validationHash).toHaveLength(64);\n    expect(receipt.snapshot.policyRulesHash).toHaveLength(64);\n    expect(receipt.snapshot.environmentConfigurationHash).toHaveLength(64);
  });

  it("rejects a mutated plan after validation", () => {
    const plan = validPlan();
    const receipt = receiptFor(plan);
    const mutated = {
      ...plan,
      steps: [{ ...plan.steps[0], reason: "mutated after validation" }]
    };
    expect(() => assertValidationReceipt(receipt, mutated, fixtureNow.getTime())).toThrow();
  });

  it("rejects tampered and expired receipts", () => {
    const plan = validPlan();
    const receipt = receiptFor(plan);

    expect(() => assertValidationReceipt({
      ...receipt,
      totalStepCostCents: receipt.totalStepCostCents + 1
    }, plan, fixtureNow.getTime())).toThrow();

    expect(() => assertValidationReceipt(receipt, plan, Date.parse("2026-09-20T18:32:00Z"))).toThrow();
  });

  it("does not allow owner-decision validation to masquerade as clean validation", () => {
    const plan = validPlan();
    const snapshot = createValidationSnapshot({
      id: "snapshot-owner-decision",
      policyVersion: "policy-v1",
      environment: plan.scope.environment,
      configurationVersion: "config-v1",
      environmentConfigurationHash: "environment-config-owner-decision",
      healthReference: {
        id: "health-1",
        version: "1",
        hash: "health-hash",
        observedAt: "2026-09-20T18:28:00Z",
        expiresAt: "2026-09-20T18:35:00Z"
      },
      capacityReference: {
        id: "capacity-1",
        version: "1",
        hash: "capacity-hash",
        observedAt: "2026-09-20T18:28:00Z",
        expiresAt: "2026-09-20T18:35:00Z"
      },
      credentialReference: {
        id: "credentials-1",
        version: "1",
        hash: "credentials-hash",
        observedAt: "2026-09-20T18:28:00Z",
        expiresAt: "2026-09-20T18:35:00Z"
      },
      createdAt: "2026-09-20T18:29:00Z"
    });
    const validation = {
      ...cleanValidation(plan),
      status: "owner-decision-required" as const,
      ownerDecisions: [{
        code: "ROLLBACK_REQUIRED" as const,
        severity: "owner-decision" as const,
        message: "Owner decision required"
      }]
    };
    const receipt = createValidationReceipt({
      id: "receipt-owner-decision",
      plan,
      validation,
      snapshot,
      validatedAt: "2026-09-20T18:29:30Z",
      expiresAt: "2026-09-20T18:31:00Z"
    });
    expect(() => assertValidationReceipt(receipt, plan, fixtureNow.getTime())).toThrow();
  });
});
