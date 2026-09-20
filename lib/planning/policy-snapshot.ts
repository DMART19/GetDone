import { CAPABILITY_REGISTRY_HASH, CAPABILITY_REGISTRY_VERSION } from "@/lib/domain/capabilities";
import type { KillSwitch } from "@/lib/domain/kill-switch";
import type { BudgetPolicy, Guardrail } from "@/lib/domain/objectives";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { ResourceRequirementEnvelope } from "@/lib/planning/plan-schema";

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
  guardrails?: PolicyGuardrailSnapshot;
  killSwitches: readonly KillSwitch[];

  credentialBindingIds: readonly string[];
  credentialBindingsAvailable: boolean;
  protectedHeadroomSatisfied: boolean;
  fallbackRequired: boolean;
  fallbackAvailable: boolean;
  idempotencyKey: string;

  resourceRequirements: ResourceRequirementEnvelope;
  createdAt: string;
}

export interface PolicySnapshot extends PolicySnapshotInput {
  capabilityRegistryVersion: string;
  capabilityRegistryHash: string;
  resourceRequirementsHash: string;
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
  const base = {
    ...input,
    scope: { ...input.scope },
    capabilityNames: [...new Set(input.capabilityNames)].sort(),
    allowedEnvironments: [...input.allowedEnvironments],
    allowedDataClasses: [...input.allowedDataClasses],
    allowedRegions: input.allowedRegions ? [...input.allowedRegions] : undefined,
    killSwitches: input.killSwitches.map((item) => ({ ...item })),
    credentialBindingIds: [...input.credentialBindingIds].sort(),
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
    capabilityRegistryHash: CAPABILITY_REGISTRY_HASH,
    resourceRequirementsHash: sha256Hex(input.resourceRequirements)
  };
  return deepFreeze({
    ...base,
    snapshotHash: sha256Hex(base)
  });
}
