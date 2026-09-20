import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { CAPABILITY_REGISTRY_HASH, CAPABILITY_REGISTRY_VERSION } from "@/lib/domain/capabilities";
import {
  CURRENT_POLICY_REGISTRY_HASH,
  CURRENT_POLICY_VERSION,
  assertCurrentPolicyVersion
} from "@/lib/domain/policy-registry";
import { POLICY_ENGINE_VERSION, POLICY_RULES_HASH } from "@/lib/planning/policy-engine";
import { hashPlan, planStepHashes } from "@/lib/planning/plan-hash";
import type { PlanProposal } from "@/lib/planning/plan-schema";
import {
  assertPlanValidatorAttestation,
  PLAN_VALIDATOR_RULES_HASH,
  PLAN_VALIDATOR_VERSION,
  type PlanValidatorAttestation
} from "@/lib/planning/plan-validator";

export interface ValidationEvidenceReference {
  id: string;
  version?: string;
  hash: string;
  observedAt?: string;
  expiresAt?: string;
}

export type ValidationEvidenceRequirement = "required" | "not-applicable";
export type ValidationEvidenceStatus = "provided" | "not-applicable";

export interface ValidationEvidenceRequirements {
  health: ValidationEvidenceRequirement;
  capacity: ValidationEvidenceRequirement;
  credentials: ValidationEvidenceRequirement;
}

export interface ValidationSnapshotInput {
  id: string;
  policyVersion: string;
  environment: PlanProposal["scope"]["environment"];
  configurationVersion: string;
  environmentConfigurationHash?: string;
  evidenceRequirements: ValidationEvidenceRequirements;

  healthReference?: ValidationEvidenceReference;
  capacityReference?: ValidationEvidenceReference;
  credentialReference?: ValidationEvidenceReference;

  createdAt: string;
  expiresAt?: string;
}

export interface ValidationSnapshot extends ValidationSnapshotInput {
  policyRegistryHash: string;
  policyEngineVersion: string;
  policyRulesHash: string;
  capabilityRegistryVersion: string;
  capabilityRegistryHash: string;
  environmentConfigurationHash: string;
  evidenceStatus: Readonly<{
    health: ValidationEvidenceStatus;
    capacity: ValidationEvidenceStatus;
    credentials: ValidationEvidenceStatus;
  }>;
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
  status: PlanValidatorAttestation["status"];
  errors: PlanValidatorAttestation["errors"];
  warnings: PlanValidatorAttestation["warnings"];
  ownerDecisions: PlanValidatorAttestation["ownerDecisions"];
  orderedStepIds: readonly string[];
  totalStepCostCents: number;
  snapshot: ValidationSnapshot;
  validatorVersion: string;
  validatorRulesHash: string;
  validatorAttestationHash: string;
  validationPolicyHash: string;
  validatedAt: string;
  expiresAt: string;
  validationHash: string;
  receiptHash: string;
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function assertReference(
  reference: ValidationEvidenceReference | undefined,
  now: number,
  label: string
) {
  if (!reference) return;
  if (!reference.id || !SHA256_HEX.test(reference.hash)) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      `${label} validation reference requires id and a SHA-256 hash`
    );
  }
  if (reference.observedAt && Date.parse(reference.observedAt) > now) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      `${label} validation reference is from the future`
    );
  }
  if (reference.expiresAt && Date.parse(reference.expiresAt) <= now) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      `${label} validation reference has expired`
    );
  }
}

function evidenceStatus(
  requirement: ValidationEvidenceRequirement,
  reference: ValidationEvidenceReference | undefined,
  label: string
): ValidationEvidenceStatus {
  if (requirement === "required" && !reference) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      `${label} evidence is required for validation`
    );
  }
  if (requirement === "not-applicable" && reference) return "provided";
  return reference ? "provided" : "not-applicable";
}

export function createValidationSnapshot(input: ValidationSnapshotInput): ValidationSnapshot {
  assertCurrentPolicyVersion(input.policyVersion);

  const createdAt = Date.parse(input.createdAt);
  if (!Number.isFinite(createdAt)) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Validation snapshot creation time is invalid"
    );
  }
  if (input.expiresAt && Date.parse(input.expiresAt) <= createdAt) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Validation snapshot expiry must follow creation time"
    );
  }

  assertReference(input.healthReference, createdAt, "Health");
  assertReference(input.capacityReference, createdAt, "Capacity");
  assertReference(input.credentialReference, createdAt, "Credential");

  const environmentConfigurationHash = sha256Hex({
    environment: input.environment,
    configurationVersion: input.configurationVersion
  });
  if (
    input.environmentConfigurationHash
    && input.environmentConfigurationHash !== environmentConfigurationHash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Environment configuration hash does not match the authoritative configuration"
    );
  }

  const evidence = {
    health: evidenceStatus(
      input.evidenceRequirements.health,
      input.healthReference,
      "Health"
    ),
    capacity: evidenceStatus(
      input.evidenceRequirements.capacity,
      input.capacityReference,
      "Capacity"
    ),
    credentials: evidenceStatus(
      input.evidenceRequirements.credentials,
      input.credentialReference,
      "Credential"
    )
  } as const;

  const base = {
    ...input,
    policyVersion: CURRENT_POLICY_VERSION,
    policyRegistryHash: CURRENT_POLICY_REGISTRY_HASH,
    policyEngineVersion: POLICY_ENGINE_VERSION,
    policyRulesHash: POLICY_RULES_HASH,
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
    capabilityRegistryHash: CAPABILITY_REGISTRY_HASH,
    environmentConfigurationHash,
    evidenceStatus: evidence,
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

export function assertValidationSnapshot(
  snapshot: ValidationSnapshot,
  now = Date.now()
) {
  const { snapshotHash, ...base } = snapshot;
  if (sha256Hex(base) !== snapshotHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Validation snapshot integrity check failed"
    );
  }

  if (
    snapshot.policyVersion !== CURRENT_POLICY_VERSION
    || snapshot.policyRegistryHash !== CURRENT_POLICY_REGISTRY_HASH
    || snapshot.policyEngineVersion !== POLICY_ENGINE_VERSION
    || snapshot.policyRulesHash !== POLICY_RULES_HASH
    || snapshot.capabilityRegistryVersion !== CAPABILITY_REGISTRY_VERSION
    || snapshot.capabilityRegistryHash !== CAPABILITY_REGISTRY_HASH
  ) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Validation snapshot references stale policy or capability definitions"
    );
  }

  const expectedEnvironmentHash = sha256Hex({
    environment: snapshot.environment,
    configurationVersion: snapshot.configurationVersion
  });
  if (snapshot.environmentConfigurationHash !== expectedEnvironmentHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Validation environment configuration hash is invalid"
    );
  }

  if (
    Date.parse(snapshot.createdAt) > now
    || (snapshot.expiresAt && Date.parse(snapshot.expiresAt) <= now)
  ) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Validation snapshot is not currently valid"
    );
  }

  assertReference(snapshot.healthReference, now, "Health");
  assertReference(snapshot.capacityReference, now, "Capacity");
  assertReference(snapshot.credentialReference, now, "Credential");
  evidenceStatus(snapshot.evidenceRequirements.health, snapshot.healthReference, "Health");
  evidenceStatus(snapshot.evidenceRequirements.capacity, snapshot.capacityReference, "Capacity");
  evidenceStatus(snapshot.evidenceRequirements.credentials, snapshot.credentialReference, "Credential");

  return snapshot;
}

export function createValidationReceipt(input: {
  id: string;
  plan: PlanProposal;
  attestation: PlanValidatorAttestation;
  snapshot: ValidationSnapshot;
  validatedAt: string;
  expiresAt: string;
}): PlanValidationReceipt {
  if (input.snapshot.environment !== input.plan.scope.environment) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Validation snapshot environment does not match plan"
    );
  }

  const validatedAt = Date.parse(input.validatedAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (
    !Number.isFinite(validatedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= validatedAt
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Validation receipt expiry must follow validation time"
    );
  }

  assertValidationSnapshot(input.snapshot, validatedAt);
  assertPlanValidatorAttestation(input.attestation, input.plan);

  const planHash = hashPlan(input.plan);
  const stepHashes = planStepHashes(input.plan);
  const validationMaterial = {
    planId: input.plan.id,
    planHash,
    stepHashes,
    status: input.attestation.status,
    errors: input.attestation.errors,
    warnings: input.attestation.warnings,
    ownerDecisions: input.attestation.ownerDecisions,
    orderedStepIds: input.attestation.orderedStepIds,
    totalStepCostCents: input.attestation.totalStepCostCents,
    snapshotHash: input.snapshot.snapshotHash,
    validatorAttestationHash: input.attestation.attestationHash,
    validatedAt: input.validatedAt
  };
  const validationHash = sha256Hex(validationMaterial);

  const base = {
    id: input.id,
    planId: input.plan.id,
    planHash,
    stepHashes,
    status: input.attestation.status,
    errors: input.attestation.errors.map((item) => ({ ...item })),
    warnings: input.attestation.warnings.map((item) => ({ ...item })),
    ownerDecisions: input.attestation.ownerDecisions.map((item) => ({ ...item })),
    orderedStepIds: [...input.attestation.orderedStepIds],
    totalStepCostCents: input.attestation.totalStepCostCents,
    snapshot: input.snapshot,
    validatorVersion: input.attestation.validatorVersion,
    validatorRulesHash: input.attestation.validatorRulesHash,
    validatorAttestationHash: input.attestation.attestationHash,
    validationPolicyHash: input.attestation.validationPolicyHash,
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
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Validation receipt integrity check failed"
    );
  }

  assertValidationSnapshot(receipt.snapshot, now);

  if (
    receipt.validatorVersion !== PLAN_VALIDATOR_VERSION
    || receipt.validatorRulesHash !== PLAN_VALIDATOR_RULES_HASH
    || !SHA256_HEX.test(receipt.validatorAttestationHash)
    || !SHA256_HEX.test(receipt.validationPolicyHash)
  ) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Validation receipt references an invalid or stale validator attestation"
    );
  }

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
    validatorAttestationHash: receipt.validatorAttestationHash,
    validatedAt: receipt.validatedAt
  });

  if (receipt.validationHash !== expectedValidationHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Validation result hash does not match receipt contents"
    );
  }

  if (
    receipt.status !== "valid"
    || receipt.errors.length > 0
    || receipt.ownerDecisions.length > 0
  ) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Plan does not have a clean deterministic validation receipt"
    );
  }

  if (receipt.planId !== plan.id || receipt.planHash !== hashPlan(plan)) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Validation receipt does not match the current plan"
    );
  }

  const expectedSteps = planStepHashes(plan);
  const actualKeys = Object.keys(receipt.stepHashes).sort();
  const expectedKeys = Object.keys(expectedSteps).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some(
      (key, index) =>
        key !== expectedKeys[index]
        || receipt.stepHashes[key] !== expectedSteps[key]
    )
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Validation receipt does not match current plan steps"
    );
  }

  if (receipt.snapshot.environment !== plan.scope.environment) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Validation receipt environment does not match plan"
    );
  }

  if (
    Date.parse(receipt.validatedAt) > now
    || Date.parse(receipt.expiresAt) <= now
  ) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Validation receipt is not currently valid"
    );
  }

  return receipt;
}
