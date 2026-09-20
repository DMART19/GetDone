import { describe, expect, it } from "vitest";
import {
  createCredentialAvailabilitySnapshot,
  evaluateCredentialAvailability
} from "@/lib/domain/credential-binding";
import {
  createBudgetReservation,
  assertBudgetReservation
} from "@/lib/domain/budget-reservation";
import {
  createProtectedCapacitySnapshot,
  assertProtectedCapacitySnapshot
} from "@/lib/domain/protected-capacity";
import { issueAuthorizationGrant } from "@/lib/authorization/grants";
import { hashPlan, hashPlanStep } from "@/lib/planning/plan-hash";
import { createPolicySnapshot } from "@/lib/planning/policy-snapshot";
import { evaluateStepPolicy } from "@/lib/planning/policy-engine";
import { createWorkAdmissionEnvelope, assertWorkAdmissionEnvelope } from "@/lib/planning/work-admission";
import { validPlan } from "@/lib/planning/test-fixture";
import { fixtureNow, fixtureScope, receiptFor } from "@/lib/planning/test-security-fixture";

describe("typed work-admission contracts", () => {
  it("binds credential, budget, capacity, policy, receipt, and authorization into one immutable admission envelope", () => {
    const plan = validPlan();
    const step = plan.steps[0];
    const scope = fixtureScope(plan);
    const planHash = hashPlan(plan);
    const stepHash = hashPlanStep(step);
    const receipt = receiptFor(plan);

    const credentials = createCredentialAvailabilitySnapshot({
      id: "credential-snapshot-1",
      portfolioId: scope.portfolioId,
      companyId: scope.companyId,
      requirements: [{
        id: "credential-requirement-1",
        capability: "repository.inspect",
        providerId: "github",
        environment: "staging",
        requiredScopes: ["repo:read"],
        required: true
      }],
      references: [{
        id: "credential-binding-1",
        companyId: scope.companyId,
        providerId: "github",
        environment: "staging",
        capabilityNames: ["repository.inspect"],
        grantedScopes: ["repo:read"],
        status: "active",
        expiresAt: "2026-09-20T19:00:00Z"
      }],
      checkedAt: "2026-09-20T18:29:00Z",
      expiresAt: "2026-09-20T18:35:00Z"
    });
    expect(evaluateCredentialAvailability(credentials, {
      scope,
      capabilities: ["repository.inspect"],
      now: fixtureNow.getTime()
    }).satisfied).toBe(true);

    const budgetReservation = createBudgetReservation({
      id: "budget-reservation-1",
      portfolioId: scope.portfolioId,
      companyId: scope.companyId,
      policyId: "budget-policy-1",
      policyVersion: "budget-v1",
      planHash,
      stepHash,
      amountCents: step.estimatedCostCents,
      currency: "USD",
      reservedAt: "2026-09-20T18:29:00Z",
      expiresAt: "2026-09-20T18:35:00Z"
    });
    expect(assertBudgetReservation({
      reservation: budgetReservation,
      scope,
      planHash,
      stepHash,
      minimumAmountCents: step.estimatedCostCents,
      now: fixtureNow.getTime()
    }).id).toBe("budget-reservation-1");

    const capacity = createProtectedCapacitySnapshot({
      id: "capacity-snapshot-1",
      portfolioId: scope.portfolioId,
      companyId: scope.companyId,
      capacityClass: "cpu",
      totalUnits: 100,
      committedUnits: 40,
      protectedMinimumFreeUnits: 20,
      requestedUnits: 10,
      observedAt: "2026-09-20T18:29:00Z",
      expiresAt: "2026-09-20T18:35:00Z"
    });
    expect(assertProtectedCapacitySnapshot({
      snapshot: capacity,
      scope,
      now: fixtureNow.getTime()
    }).headroomSatisfied).toBe(true);

    const budget = {
      policy: {
        id: "budget-policy-1",
        scopeId: scope.companyId,
        currency: "USD",
        period: "monthly" as const,
        hardLimitCents: 100_000,
        enabled: true
      },
      currentSpendCents: 10_000,
      requestedCostCents: step.estimatedCostCents
    };

    const policySnapshot = createPolicySnapshot({
      id: "policy-snapshot-admission",
      policyVersion: receipt.snapshot.policyVersion,
      scope,
      planHash,
      stepHash,
      capabilityNames: ["repository.inspect"],
      dataClass: plan.scope.dataClass,
      region: "us-west",
      allowedEnvironments: [plan.scope.environment],
      allowedDataClasses: [plan.scope.dataClass],
      allowedRegions: ["us-west"],
      budget,
      budgetReservation,
      killSwitches: [],
      credentialRequirementIds: ["credential-requirement-1"],
      credentialSnapshot: credentials,
      capacitySnapshot: capacity,
      fallbackRequired: false,
      fallbackAvailable: true,
      idempotencyKey: "admission-policy-1",
      resourceRequirements: step.resourceRequirements,
      createdAt: fixtureNow.toISOString()
    });

    const policyEvaluation = evaluateStepPolicy({
      authenticated: true,
      scopeResolved: true,
      trustedScope: scope,
      capabilities: ["repository.inspect"],
      planHash,
      stepHash,
      environment: plan.scope.environment,
      dataClass: plan.scope.dataClass,
      region: "us-west",
      allowedEnvironments: [plan.scope.environment],
      allowedDataClasses: [plan.scope.dataClass],
      allowedRegions: ["us-west"],
      credentialRequirementIds: ["credential-requirement-1"],
      credentialSnapshot: credentials,
      capacitySnapshot: capacity,
      fallbackRequired: false,
      fallbackAvailable: true,
      idempotencyKey: "admission-policy-1",
      killSwitches: [],
      budget,
      budgetReservation,
      now: fixtureNow.getTime()
    });
    expect(policyEvaluation.readyForTaskGeneration).toBe(true);

    const grant = issueAuthorizationGrant({
      id: "grant-admission",
      plan,
      stepId: step.id,
      receipt,
      policySnapshot,
      policyEvaluation,
      actor: { type: "system", id: "getdone-policy" },
      scope,
      issuedAt: fixtureNow.toISOString(),
      expiresAt: "2026-09-20T18:30:30Z"
    });

    const admission = createWorkAdmissionEnvelope({
      id: "admission-1",
      plan,
      stepId: step.id,
      scope,
      receipt,
      policySnapshot,
      grant,
      credentialSnapshot: credentials,
      budgetReservation,
      capacitySnapshot: capacity,
      killSwitches: [],
      createdAt: fixtureNow.toISOString(),
      expiresAt: "2026-09-20T18:30:20Z"
    });

    expect(admission.admissionHash).toHaveLength(64);
    expect(admission.credentialSnapshotHash).toBe(credentials.snapshotHash);
    expect(admission.budgetReservationHash).toBe(budgetReservation.reservationHash);
    expect(admission.capacitySnapshotHash).toBe(capacity.snapshotHash);
    expect(Object.isFrozen(admission)).toBe(true);
    expect(assertWorkAdmissionEnvelope(admission, {
      scope,
      now: fixtureNow.getTime()
    })).toBe(admission);
  });
});
