import { CAPABILITY_REGISTRY_HASH, CAPABILITY_REGISTRY_VERSION } from "@/lib/domain/capabilities";
import type { KillSwitch } from "@/lib/domain/kill-switch";
import type { BudgetPolicy, Guardrail } from "@/lib/domain/objectives";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { ResourceRequirementEnvelope } from "@/lib/planning/plan-schema";
import type { CredentialAvailabilitySnapshot } from "@/lib/domain/credential-binding";
import type { BudgetReservation } from "@/lib/domain/budget-reservation";
import type { ProtectedCapacitySnapshot } from "@/lib/domain/protected-capacity";
import { POLICY_ENGINE_VERSION, POLICY_RULES_HASH } from "@/lib/planning/policy-engine";

export interface PolicyBudgetSnapshot {
  policy: BudgetPolicy;
  currentSpendCents: number;
  reservedCents?: number;
  requestedCostCents: number;
}

export interface PolicyGuardrailSnapshot {
  scopeId: string;
  policies: readonly Guardrail[];
  metrics: Readonly<Record<string, number | string | boolean | undefined>>;
}

export interface PolicySnapshotInput {
  id: string;
  policyVersion: string;
  scope: TrustedExecutionScope;
  planHash: string;
  stepHash: string;
  capabilityNames: readonly string[];
  dataClass: "public" | "internal" | "customer" | "sensitive";
  region?: string;
  allowedEnvironments: readonly TrustedExecutionScope["environment"][];
  allowedDataClasses: readonly ("public" | "internal" | "customer" | "sensitive")[];
  allowedRegions?: readonly string[];

  integrationId?: string;
  resourceId?: string;
  poolId?: string;
  providerId?: string;
  failureDomainId?: string;
  workloadClass?: string;

  budget?: PolicyBudgetSnapshot;
  budgetReservation?: BudgetReservation;
  guardrails?: PolicyGuardrailSnapshot;
  killSwitches: readonly KillSwitch[];

  credentialRequirementIds: readonly string[];
  credentialSnapshot?: CredentialAvailabilitySnapshot;
  capacitySnapshot?: ProtectedCapacitySnapshot;

  fallbackRequired: boolean;
  fallbackAvailable: boolean;
  idempotencyKey: string;

  resourceRequirements: ResourceRequirementEnvelope;
  createdAt: string;
}

export interface PolicySnapshot extends PolicySnapshotInput {
  policyEngineVersion: string;
  policyRulesHash: string;
  capabilityRegistryVersion: string;
  capabilityRegistryHash: string;
  resourceRequirementsHash: string;
  credentialSnapshotHash?: string;
  budgetReservationHash?: string;
  capacitySnapshotHash?: string;
  policyInputHash: string;
  snapshotHash: string;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function createPolicySnapshot(input: PolicySnapshotInput): PolicySnapshot {
  const policyInput = {
    policyVersion: input.policyVersion,
    scope: input.scope,
    capabilityNames: [...new Set(input.capabilityNames)].sort(),
    dataClass: input.dataClass,
    region: input.region,
    allowedEnvironments: [...input.allowedEnvironments],
    allowedDataClasses: [...input.allowedDataClasses],
    allowedRegions: input.allowedRegions ? [...input.allowedRegions] : undefined,
    integrationId: input.integrationId,
    resourceId: input.resourceId,
    poolId: input.poolId,
    providerId: input.providerId,
    failureDomainId: input.failureDomainId,
    workloadClass: input.workloadClass,
    budget: input.budget,
    budgetReservationHash: input.budgetReservation?.reservationHash,
    guardrails: input.guardrails,
    killSwitches: input.killSwitches,
    credentialRequirementIds: [...new Set(input.credentialRequirementIds)].sort(),
    credentialSnapshotHash: input.credentialSnapshot?.snapshotHash,
    capacitySnapshotHash: input.capacitySnapshot?.snapshotHash,
    fallbackRequired: input.fallbackRequired,
    fallbackAvailable: input.fallbackAvailable,
    idempotencyKey: input.idempotencyKey,
    resourceRequirementsHash: sha256Hex(input.resourceRequirements)
  };

  const base = {
    ...input,
    scope: { ...input.scope },
    capabilityNames: [...new Set(input.capabilityNames)].sort(),
    allowedEnvironments: [...input.allowedEnvironments],
    allowedDataClasses: [...input.allowedDataClasses],
    allowedRegions: input.allowedRegions ? [...input.allowedRegions] : undefined,
    killSwitches: input.killSwitches.map((item) => ({ ...item })),
    credentialRequirementIds: [...new Set(input.credentialRequirementIds)].sort(),
    policyEngineVersion: POLICY_ENGINE_VERSION,
    policyRulesHash: POLICY_RULES_HASH,
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
    capabilityRegistryHash: CAPABILITY_REGISTRY_HASH,
    resourceRequirementsHash: sha256Hex(input.resourceRequirements),
    credentialSnapshotHash: input.credentialSnapshot?.snapshotHash,
    budgetReservationHash: input.budgetReservation?.reservationHash,
    capacitySnapshotHash: input.capacitySnapshot?.snapshotHash,
    policyInputHash: sha256Hex(policyInput)
  };

  return deepFreeze({
    ...base,
    snapshotHash: sha256Hex(base)
  });
}

export function assertPolicySnapshotIntegrity(snapshot: PolicySnapshot) {
  const { snapshotHash, ...base } = snapshot;
  if (sha256Hex(base) !== snapshotHash) {
    throw new Error("Policy snapshot integrity check failed");
  }
  if (
    snapshot.policyEngineVersion !== POLICY_ENGINE_VERSION
    || snapshot.policyRulesHash !== POLICY_RULES_HASH
    || snapshot.capabilityRegistryVersion !== CAPABILITY_REGISTRY_VERSION
    || snapshot.capabilityRegistryHash !== CAPABILITY_REGISTRY_HASH
  ) {
    throw new Error("Policy snapshot references stale policy or capability definitions");
  }
  return snapshot;
}
