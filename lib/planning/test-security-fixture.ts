import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import { issueAuthorizationGrant, type AuthorizationGrant } from "@/lib/authorization/grants";
import { evaluateStepPolicy, type StepPolicyEvaluation } from "@/lib/planning/policy-engine";
import { createPolicySnapshot, type PolicySnapshot } from "@/lib/planning/policy-snapshot";
import type { PlanProposal } from "@/lib/planning/plan-schema";
import { validPlan } from "@/lib/planning/test-fixture";
import type { PlanValidationResult } from "@/lib/planning/plan-validator";
import {
  createValidationReceipt,
  createValidationSnapshot,
  type PlanValidationReceipt
} from "@/lib/planning/validation-receipt";
import { hashPlan, hashPlanStep } from "@/lib/planning/plan-hash";

export const fixtureNow = new Date("2026-09-20T18:30:00Z");

export function fixtureScope(plan: PlanProposal = validPlan()): TrustedExecutionScope {
  return {
    userId: "user-a",
    portfolioId: plan.scope.portfolioId,
    companyId: plan.scope.companyId,
    environment: plan.scope.environment
  };
}

export function cleanValidation(plan: PlanProposal): PlanValidationResult {
  return {
    status: "valid",
    errors: [],
    warnings: [],
    ownerDecisions: [],
    orderedStepIds: plan.steps.map((step) => step.id),
    totalStepCostCents: plan.steps.reduce((sum, step) => sum + step.estimatedCostCents, 0)
  };
}

export function receiptFor(
  plan: PlanProposal = validPlan(),
  now = fixtureNow
): PlanValidationReceipt {
  const snapshot = createValidationSnapshot({
    id: "validation-snapshot-1",
    policyVersion: "policy-v2",
    environment: plan.scope.environment,
    configurationVersion: "config-v1",
    createdAt: new Date(now.getTime() - 1_000).toISOString(),
    expiresAt: new Date(now.getTime() + 120_000).toISOString()
  });

  return createValidationReceipt({
    id: "validation-receipt-1",
    plan,
    validation: cleanValidation(plan),
    snapshot,
    validatedAt: new Date(now.getTime() - 500).toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString()
  });
}

export function policySnapshotFor(
  plan: PlanProposal = validPlan(),
  stepId = plan.steps[0].id,
  now = fixtureNow
): PolicySnapshot {
  const step = plan.steps.find((candidate) => candidate.id === stepId)!;
  const scope = fixtureScope(plan);
  return createPolicySnapshot({
    id: `policy-snapshot-${stepId}`,
    policyVersion: "policy-v2",
    scope,
    planHash: hashPlan(plan),
    stepHash: hashPlanStep(step),
    capabilityNames: step.capabilityRequests.map((request) => request.capability),
    dataClass: plan.scope.dataClass,
    region: "us-west",
    allowedEnvironments: [plan.scope.environment],
    allowedDataClasses: [plan.scope.dataClass],
    allowedRegions: ["us-west"],
    killSwitches: [],
    credentialRequirementIds: [],
    fallbackRequired: false,
    fallbackAvailable: true,
    idempotencyKey: `policy-${stepId}-12345678`,
    resourceRequirements: step.resourceRequirements,
    createdAt: now.toISOString()
  });
}

export function autoPolicyFor(
  plan: PlanProposal = validPlan(),
  stepId = plan.steps[0].id
): StepPolicyEvaluation {
  const step = plan.steps.find((candidate) => candidate.id === stepId)!;
  const scope = fixtureScope(plan);
  return evaluateStepPolicy({
    authenticated: true,
    scopeResolved: true,
    trustedScope: scope,
    capabilities: step.capabilityRequests.map((request) => request.capability),
    planHash: hashPlan(plan),
    stepHash: hashPlanStep(step),
    environment: plan.scope.environment,
    dataClass: plan.scope.dataClass,
    region: "us-west",
    allowedEnvironments: [plan.scope.environment],
    allowedDataClasses: [plan.scope.dataClass],
    allowedRegions: ["us-west"],
    credentialRequirementIds: [],
    fallbackRequired: false,
    fallbackAvailable: true,
    idempotencyKey: `policy-${stepId}-12345678`,
    killSwitches: []
  });
}

export function autoGrantFor(
  plan: PlanProposal = validPlan(),
  stepId = plan.steps[0].id,
  receipt = receiptFor(plan),
  now = fixtureNow
): AuthorizationGrant {
  const policySnapshot = policySnapshotFor(plan, stepId, now);
  const policyEvaluation = autoPolicyFor(plan, stepId);

  return issueAuthorizationGrant({
    id: `grant-${stepId}`,
    plan,
    stepId,
    receipt,
    policySnapshot,
    policyEvaluation,
    actor: { type: "system", id: "getdone-policy" },
    scope: fixtureScope(plan),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30_000).toISOString()
  });
}
