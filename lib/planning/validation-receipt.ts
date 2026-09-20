import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { CAPABILITY_REGISTRY_HASH, CAPABILITY_REGISTRY_VERSION } from "@/lib/domain/capabilities";
import { POLICY_ENGINE_VERSION, POLICY_RULES_HASH } from "@/lib/planning/policy-engine";
import { hashPlan, planStepHashes } from "@/lib/planning/plan-hash";
import type { PlanProposal } from "@/lib/planning/plan-schema";
import type { PlanValidationIssue, PlanValidationResult } from "@/lib/planning/plan-validator";

export interface ValidationEvidenceReference {
  id: string;
  version?: string;
  hash: string;
  observedAt?: string;
  expiresAt?: string;
}

export interface ValidationSnapshotInput {
  id: string;
  policyVersion: string;
  environment: PlanProposal["scope"]["environment"];
  configurationVersion: string;
  environmentConfigurationHash?: string;

  healthSnapshotId?: string;
  capacitySnapshotId?: string;
  credentialSnapshotId?: string;

  healthReference?: ValidationEvidenceReference;
  capacityReference?: ValidationEvidenceReference;
  credentialReference?: ValidationEvidenceReference;

  createdAt: string;
  expiresAt?: string;
}

export interface ValidationSnapshot extends ValidationSnapshotInput {
  policyEngineVersion: string;
  policyRulesHash: string;
  capabilityRegistryVersion: string;
  capabilityRegistryHash: string;
  environmentConfigurationHash: string;
  referenceHashes: Readonly<{
    health?: string;
    capacity?: string;
    credentials?: string;
  }>;
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
  validationHash: string;
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

function assertReference(reference: ValidationEvidenceReference | undefined, now: number, label: string) {
  if (!reference) return;
  if (!reference.id || !reference.hash) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} validation reference requires id and hash`);
  }
  if (reference.observedAt && Date.parse(reference.observedAt) > now) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} validation reference is from the future`);
  }
  if (reference.expiresAt && Date.parse(reference.expiresAt) <= now) {
    throw new ControlPlaneError("POLICY_BLOCKED", `${label} validation reference has expired`);
  }
}

export function createValidationSnapshot(input: ValidationSnapshotInput): ValidationSnapshot {
  const createdAt = Date.parse(input.createdAt);
  if (!Number.isFinite(createdAt)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Validation snapshot creation time is invalid");
  }
  if (input.expiresAt && Date.parse(input.expiresAt) <= createdAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Validation snapshot expiry must follow creation time");
  }

  assertReference(input.healthReference, createdAt, "Health");
  assertReference(input.capacityReference, createdAt, "Capacity");
  assertReference(input.credentialReference, createdAt, "Credential");

  const environmentConfigurationHash =
    input.environmentConfigurationHash
    ?? sha256Hex({
      environment: input.environment,
      configurationVersion: input.configurationVersion
    });

  const base = {
    ...input,
    healthSnapshotId: input.healthReference?.id ?? input.healthSnapshotId,
    capacitySnapshotId: input.capacityReference?.id ?? input.capacitySnapshotId,
    credentialSnapshotId: input.credentialReference?.id ?? input.credentialSnapshotId,
    policyEngineVersion: POLICY_ENGINE_VERSION,
    policyRulesHash: POLICY_RULES_HASH,
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
    capabilityRegistryHash: CAPABILITY_REGISTRY_HASH,
    environmentConfigurationHash,
    referenceHashes: {
      health: input.healthReference?.hash,
      capacity: input.capacityReference?.hash,
      credentials: input.credentialReference?.hash
    }
  };

  return deepFreeze({
    ...base,
    snapshotHash: sha256Hex(base)
  });
}

export function assertValidationSnapshot(snapshot: ValidationSnapshot, now = Date.now()) {
  const { snapshotHash, ...base } = snapshot;
  if (sha256Hex(base) !== snapshotHash) {
    throw new ControlPlaneError("FORBIDDEN", "Validation snapshot integrity check failed");
  }
  if (
    snapshot.policyEngineVersion !== POLICY_ENGINE_VERSION
    || snapshot.policyRulesHash !== POLICY_RULES_HASH
    || snapshot.capabilityRegistryVersion !== CAPABILITY_REGISTRY_VERSION
    || snapshot.capabilityRegistryHash !== CAPABILITY_REGISTRY_HASH
  ) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Validation snapshot references stale policy or capability definitions");
  }
  if (Date.parse(snapshot.createdAt) > now || (snapshot.expiresAt && Date.parse(snapshot.expiresAt) <= now)) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Validation snapshot is not currently valid");
  }
  assertReference(snapshot.healthReference, now, "Health");
  assertReference(snapshot.capacityReference, now, "Capacity");
  assertReference(snapshot.credentialReference, now, "Credential");
  return snapshot;
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

  assertValidationSnapshot(input.snapshot, validatedAt);

  const planHash = hashPlan(input.plan);
  const stepHashes = planStepHashes(input.plan);
  const validationMaterial = {
    planId: input.plan.id,
    planHash,
    stepHashes,
    status: input.validation.status,
    errors: input.validation.errors,
    warnings: input.validation.warnings,
    ownerDecisions: input.validation.ownerDecisions,
    orderedStepIds: input.validation.orderedStepIds,
    totalStepCostCents: input.validation.totalStepCostCents,
    snapshotHash: input.snapshot.snapshotHash,
    validatedAt: input.validatedAt
  };
  const validationHash = sha256Hex(validationMaterial);

  const base = {
    id: input.id,
    planId: input.plan.id,
    planHash,
    stepHashes,
    status: input.validation.status,
    errors: input.validation.errors.map((item) => ({ ...item })),
    warnings: input.validation.warnings.map((item) => ({ ...item })),
    ownerDecisions: input.validation.ownerDecisions.map((item) => ({ ...item })),
    orderedStepIds: [...input.validation.orderedStepIds],
    totalStepCostCents: input.validation.totalStepCostCents,
    snapshot: input.snapshot,
    validatedAt: input.validatedAt,
    expiresAt: input.expiresAt,
    validationHash
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

  assertValidationSnapshot(receipt.snapshot, now);

  const expectedValidationHash = sha256Hex({
    planId: receipt.planId,
    planHash: receipt.planHash,
    stepHashes: receipt.stepHashes,
    status: receipt.status,
    errors: receipt.errors,
    warnings: receipt.warnings,
    ownerDecisions: receipt.ownerDecisions,
    orderedStepIds: receipt.orderedStepIds,
    totalStepCostCents: receipt.totalStepCostCents,
    snapshotHash: receipt.snapshot.snapshotHash,
    validatedAt: receipt.validatedAt
  });
  if (receipt.validationHash !== expectedValidationHash) {
    throw new ControlPlaneError("FORBIDDEN", "Validation result hash does not match receipt contents");
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

  if (receipt.snapshot.environment !== plan.scope.environment) {
    throw new ControlPlaneError("FORBIDDEN", "Validation receipt environment does not match plan");
  }

  if (Date.parse(receipt.validatedAt) > now || Date.parse(receipt.expiresAt) <= now) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Validation receipt is not currently valid");
  }

  return receipt;
}
