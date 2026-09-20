import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import { assertTrustedExecutionScopeEqual } from "@/lib/control-plane/trusted-execution-scope";
import type { AuthorizationGrant } from "@/lib/authorization/grants";
import { assertAuthorizationGrant } from "@/lib/authorization/grants";
import type { CredentialAvailabilitySnapshot } from "@/lib/domain/credential-binding";
import { evaluateCredentialAvailability } from "@/lib/domain/credential-binding";
import type { BudgetReservation } from "@/lib/domain/budget-reservation";
import { assertBudgetReservation } from "@/lib/domain/budget-reservation";
import type { ProtectedCapacitySnapshot } from "@/lib/domain/protected-capacity";
import { assertProtectedCapacitySnapshot } from "@/lib/domain/protected-capacity";
import type { KillSwitch } from "@/lib/domain/kill-switch";
import type { ResourceRequirementEnvelope, PlanProposal } from "@/lib/planning/plan-schema";
import type { PolicySnapshot } from "@/lib/planning/policy-snapshot";
import { assertPolicySnapshotIntegrity } from "@/lib/planning/policy-snapshot";
import type { PlanValidationReceipt } from "@/lib/planning/validation-receipt";
import { assertValidationReceipt } from "@/lib/planning/validation-receipt";
import { hashPlan, hashPlanStep } from "@/lib/planning/plan-hash";

export interface WorkAdmissionEnvelope {
  id: string;
  scope: TrustedExecutionScope;
  planId: string;
  planHash: string;
  stepId: string;
  stepHash: string;
  capabilityNames: readonly string[];
  environment: TrustedExecutionScope["environment"];
  dataClass: "public" | "internal" | "customer" | "sensitive";
  region?: string;

  validationReceiptId: string;
  validationReceiptHash: string;
  policySnapshotId: string;
  policySnapshotHash: string;
  authorizationGrantId: string;
  authorizationGrantHash: string;

  credentialSnapshotId?: string;
  credentialSnapshotHash?: string;
  budgetReservationId?: string;
  budgetReservationHash?: string;
  capacitySnapshotId?: string;
  capacitySnapshotHash?: string;

  killSwitchIds: readonly string[];
  resourceRequirements: ResourceRequirementEnvelope;
  createdAt: string;
  expiresAt: string;
  admissionHash: string;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function createWorkAdmissionEnvelope(input: {
  id: string;
  plan: PlanProposal;
  stepId: string;
  scope: TrustedExecutionScope;
  receipt: PlanValidationReceipt;
  policySnapshot: PolicySnapshot;
  grant: AuthorizationGrant;
  credentialSnapshot?: CredentialAvailabilitySnapshot;
  budgetReservation?: BudgetReservation;
  capacitySnapshot?: ProtectedCapacitySnapshot;
  killSwitches: readonly KillSwitch[];
  createdAt: string;
  expiresAt: string;
}): WorkAdmissionEnvelope {
  const createdAt = Date.parse(input.createdAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Work admission expiry must follow creation time");
  }

  const step = input.plan.steps.find((candidate) => candidate.id === input.stepId);
  if (!step) throw new ControlPlaneError("NOT_FOUND", "Plan step was not found");

  assertValidationReceipt(input.receipt, input.plan, createdAt);
  assertPolicySnapshotIntegrity(input.policySnapshot);
  assertAuthorizationGrant({
    grant: input.grant,
    plan: input.plan,
    stepId: input.stepId,
    receipt: input.receipt,
    scope: input.scope,
    now: createdAt
  });

  assertTrustedExecutionScopeEqual(input.scope, input.policySnapshot.scope, {
    requireSameResource: Boolean(input.scope.resourceId || input.policySnapshot.scope.resourceId)
  });

  const planHash = hashPlan(input.plan);
  const stepHash = hashPlanStep(step);
  if (
    input.policySnapshot.planHash !== planHash
    || input.policySnapshot.stepHash !== stepHash
    || input.grant.policySnapshotId !== input.policySnapshot.id
    || input.grant.policySnapshotHash !== input.policySnapshot.snapshotHash
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Admission authority chain does not bind to the same plan step");
  }

  if (input.credentialSnapshot) {
    const credentialResult = evaluateCredentialAvailability(input.credentialSnapshot, {
      scope: input.scope,
      capabilities: step.capabilityRequests.map((request) => request.capability),
      now: createdAt
    });
    if (!credentialResult.satisfied) {
      throw new ControlPlaneError("POLICY_BLOCKED", "Credential requirements are not satisfied for admitted work");
    }
    if (input.policySnapshot.credentialSnapshotHash !== input.credentialSnapshot.snapshotHash) {
      throw new ControlPlaneError("FORBIDDEN", "Admission credential snapshot differs from policy snapshot");
    }
  } else if (input.policySnapshot.credentialRequirementIds.length > 0) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Credential-bound work requires a credential snapshot");
  }

  if (input.budgetReservation) {
    assertBudgetReservation({
      reservation: input.budgetReservation,
      scope: input.scope,
      planHash,
      stepHash,
      minimumAmountCents: step.estimatedCostCents,
      now: createdAt
    });
    if (input.policySnapshot.budgetReservationHash !== input.budgetReservation.reservationHash) {
      throw new ControlPlaneError("FORBIDDEN", "Admission budget reservation differs from policy snapshot");
    }
  } else if (step.estimatedCostCents > 0 && input.policySnapshot.budget) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Budgeted work requires a reservation before admission");
  }

  if (input.capacitySnapshot) {
    assertProtectedCapacitySnapshot({
      snapshot: input.capacitySnapshot,
      scope: input.scope,
      resourceId: input.policySnapshot.resourceId ?? input.scope.resourceId,
      poolId: input.policySnapshot.poolId,
      now: createdAt
    });
    if (input.policySnapshot.capacitySnapshotHash !== input.capacitySnapshot.snapshotHash) {
      throw new ControlPlaneError("FORBIDDEN", "Admission capacity snapshot differs from policy snapshot");
    }
  }

  if (input.grant.expiresAt < input.expiresAt || input.receipt.expiresAt < input.expiresAt) {
    throw new ControlPlaneError("FORBIDDEN", "Work admission cannot outlive its validation or authorization");
  }

  const base = {
    id: input.id,
    scope: { ...input.scope },
    planId: input.plan.id,
    planHash,
    stepId: step.id,
    stepHash,
    capabilityNames: [...new Set(step.capabilityRequests.map((request) => request.capability))].sort(),
    environment: input.plan.scope.environment,
    dataClass: input.plan.scope.dataClass,
    region: input.policySnapshot.region,
    validationReceiptId: input.receipt.id,
    validationReceiptHash: input.receipt.receiptHash,
    policySnapshotId: input.policySnapshot.id,
    policySnapshotHash: input.policySnapshot.snapshotHash,
    authorizationGrantId: input.grant.id,
    authorizationGrantHash: input.grant.grantHash,
    credentialSnapshotId: input.credentialSnapshot?.id,
    credentialSnapshotHash: input.credentialSnapshot?.snapshotHash,
    budgetReservationId: input.budgetReservation?.id,
    budgetReservationHash: input.budgetReservation?.reservationHash,
    capacitySnapshotId: input.capacitySnapshot?.id,
    capacitySnapshotHash: input.capacitySnapshot?.snapshotHash,
    killSwitchIds: input.killSwitches.filter((item) => item.enabled).map((item) => item.id).sort(),
    resourceRequirements: step.resourceRequirements,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt
  };

  return deepFreeze({
    ...base,
    admissionHash: sha256Hex(base)
  });
}

export function assertWorkAdmissionEnvelope(
  envelope: WorkAdmissionEnvelope,
  input: { scope: TrustedExecutionScope; now?: number }
) {
  const { admissionHash, ...base } = envelope;
  if (sha256Hex(base) !== admissionHash) {
    throw new ControlPlaneError("FORBIDDEN", "Work admission envelope integrity check failed");
  }
  assertTrustedExecutionScopeEqual(input.scope, envelope.scope, {
    requireSameResource: Boolean(input.scope.resourceId || envelope.scope.resourceId)
  });
  const now = input.now ?? Date.now();
  if (Date.parse(envelope.createdAt) > now || Date.parse(envelope.expiresAt) <= now) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Work admission envelope is not currently valid");
  }
  return envelope;
}
