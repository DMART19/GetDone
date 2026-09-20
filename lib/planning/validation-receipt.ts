import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { CAPABILITY_REGISTRY_HASH, CAPABILITY_REGISTRY_VERSION } from "@/lib/domain/capabilities";
import { hashPlan, planStepHashes } from "@/lib/planning/plan-hash";
import type { PlanProposal } from "@/lib/planning/plan-schema";
import type { PlanValidationIssue, PlanValidationResult } from "@/lib/planning/plan-validator";

export interface ValidationSnapshotInput {
  id: string;
  policyVersion: string;
  environment: PlanProposal["scope"]["environment"];
  configurationVersion: string;
  healthSnapshotId?: string;
  capacitySnapshotId?: string;
  credentialSnapshotId?: string;
  createdAt: string;
}

export interface ValidationSnapshot extends ValidationSnapshotInput {
  capabilityRegistryVersion: string;
  capabilityRegistryHash: string;
  snapshotHash: string;
}

export interface PlanValidationReceipt {
  id: string;
  planId: string;
  planHash: string;
  stepHashes: Readonly<Record<string, string>>;
  status: PlanValidationResult["status"];
  errors: readonly PlanValidationIssue[];
  warnings: readonly PlanValidationIssue[];
  ownerDecisions: readonly PlanValidationIssue[];
  orderedStepIds: readonly string[];
  totalStepCostCents: number;
  snapshot: ValidationSnapshot;
  validatedAt: string;
  expiresAt: string;
  receiptHash: string;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function createValidationSnapshot(input: ValidationSnapshotInput): ValidationSnapshot {
  const base = {
    ...input,
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
    capabilityRegistryHash: CAPABILITY_REGISTRY_HASH
  };
  return deepFreeze({
    ...base,
    snapshotHash: sha256Hex(base)
  });
}

export function createValidationReceipt(input: {
  id: string;
  plan: PlanProposal;
  validation: PlanValidationResult;
  snapshot: ValidationSnapshot;
  validatedAt: string;
  expiresAt: string;
}): PlanValidationReceipt {
  if (input.snapshot.environment !== input.plan.scope.environment) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Validation snapshot environment does not match plan");
  }

  const validatedAt = Date.parse(input.validatedAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(validatedAt) || !Number.isFinite(expiresAt) || expiresAt <= validatedAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Validation receipt expiry must follow validation time");
  }

  const base = {
    id: input.id,
    planId: input.plan.id,
    planHash: hashPlan(input.plan),
    stepHashes: planStepHashes(input.plan),
    status: input.validation.status,
    errors: input.validation.errors.map((item) => ({ ...item })),
    warnings: input.validation.warnings.map((item) => ({ ...item })),
    ownerDecisions: input.validation.ownerDecisions.map((item) => ({ ...item })),
    orderedStepIds: [...input.validation.orderedStepIds],
    totalStepCostCents: input.validation.totalStepCostCents,
    snapshot: input.snapshot,
    validatedAt: input.validatedAt,
    expiresAt: input.expiresAt
  };

  return deepFreeze({
    ...base,
    receiptHash: sha256Hex(base)
  });
}

export function assertValidationReceipt(
  receipt: PlanValidationReceipt,
  plan: PlanProposal,
  now = Date.now()
) {
  const { receiptHash, ...base } = receipt;
  if (sha256Hex(base) !== receiptHash) {
    throw new ControlPlaneError("FORBIDDEN", "Validation receipt integrity check failed");
  }
  if (receipt.status !== "valid" || receipt.errors.length > 0 || receipt.ownerDecisions.length > 0) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Plan does not have a clean deterministic validation receipt");
  }
  if (receipt.planId !== plan.id || receipt.planHash !== hashPlan(plan)) {
    throw new ControlPlaneError("FORBIDDEN", "Validation receipt does not match the current plan");
  }

  const expectedSteps = planStepHashes(plan);
  const actualKeys = Object.keys(receipt.stepHashes).sort();
  const expectedKeys = Object.keys(expectedSteps).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index] || receipt.stepHashes[key] !== expectedSteps[key])
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Validation receipt does not match current plan steps");
  }

  if (
    receipt.snapshot.capabilityRegistryVersion !== CAPABILITY_REGISTRY_VERSION
    || receipt.snapshot.capabilityRegistryHash !== CAPABILITY_REGISTRY_HASH
  ) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Capability registry changed after validation");
  }

  if (receipt.snapshot.environment !== plan.scope.environment) {
    throw new ControlPlaneError("FORBIDDEN", "Validation receipt environment does not match plan");
  }

  if (Date.parse(receipt.validatedAt) > now || Date.parse(receipt.expiresAt) <= now) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Validation receipt is not currently valid");
  }

  return receipt;
}
