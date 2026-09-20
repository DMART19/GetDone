import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export interface CredentialBindingRequirement {
  id: string;
  capability: string;
  providerId?: string;
  environment: TrustedExecutionScope["environment"];
  requiredScopes: readonly string[];
  required: boolean;
}

export interface CredentialBindingReference {
  id: string;
  companyId: string;
  providerId: string;
  environment: TrustedExecutionScope["environment"];
  capabilityNames: readonly string[];
  grantedScopes: readonly string[];
  status: "active" | "expired" | "revoked" | "unavailable";
  expiresAt?: string;
}

export interface CredentialAvailabilitySnapshot {
  id: string;
  portfolioId: string;
  companyId: string;
  requirements: readonly CredentialBindingRequirement[];
  references: readonly CredentialBindingReference[];
  checkedAt: string;
  expiresAt: string;
  snapshotHash: string;
}

export interface CredentialAvailabilityResult {
  satisfied: boolean;
  missingRequirementIds: readonly string[];
  matchingBindingIds: readonly string[];
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function bindingMatches(
  requirement: CredentialBindingRequirement,
  binding: CredentialBindingReference,
  companyId: string,
  now: number
) {
  if (
    binding.companyId !== companyId
    || binding.environment !== requirement.environment
    || binding.status !== "active"
  ) return false;
  if (requirement.providerId && binding.providerId !== requirement.providerId) return false;
  if (!binding.capabilityNames.includes(requirement.capability)) return false;
  if (binding.expiresAt && Date.parse(binding.expiresAt) <= now) return false;
  return requirement.requiredScopes.every((scope) => binding.grantedScopes.includes(scope));
}

export function createCredentialAvailabilitySnapshot(input: Omit<CredentialAvailabilitySnapshot, "snapshotHash">) {
  const checkedAt = Date.parse(input.checkedAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(checkedAt) || !Number.isFinite(expiresAt) || expiresAt <= checkedAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Credential availability snapshot has an invalid time window");
  }

  const base = {
    ...input,
    requirements: input.requirements.map((item) => ({
      ...item,
      requiredScopes: uniqueSorted(item.requiredScopes)
    })),
    references: input.references.map((item) => ({
      ...item,
      capabilityNames: uniqueSorted(item.capabilityNames),
      grantedScopes: uniqueSorted(item.grantedScopes)
    }))
  };

  return Object.freeze({
    ...base,
    requirements: Object.freeze(base.requirements.map(Object.freeze)),
    references: Object.freeze(base.references.map(Object.freeze)),
    snapshotHash: sha256Hex(base)
  });
}

export function evaluateCredentialAvailability(
  snapshot: CredentialAvailabilitySnapshot,
  input: {
    scope: TrustedExecutionScope;
    capabilities: readonly string[];
    now?: number;
  }
): CredentialAvailabilityResult {
  const { snapshotHash, ...base } = snapshot;
  if (sha256Hex(base) !== snapshotHash) {
    throw new ControlPlaneError("FORBIDDEN", "Credential availability snapshot integrity check failed");
  }

  const now = input.now ?? Date.now();
  if (
    snapshot.portfolioId !== input.scope.portfolioId
    || snapshot.companyId !== input.scope.companyId
    || Date.parse(snapshot.checkedAt) > now
    || Date.parse(snapshot.expiresAt) <= now
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Credential availability snapshot is stale or out of scope");
  }

  const capabilities = new Set(input.capabilities);
  const requirements = snapshot.requirements.filter((item) =>
    item.required && capabilities.has(item.capability)
  );

  const missing: string[] = [];
  const matching = new Set<string>();
  for (const requirement of requirements) {
    const match = snapshot.references.find((binding) =>
      bindingMatches(requirement, binding, input.scope.companyId, now)
    );
    if (!match) missing.push(requirement.id);
    else matching.add(match.id);
  }

  return {
    satisfied: missing.length === 0,
    missingRequirementIds: Object.freeze(missing),
    matchingBindingIds: Object.freeze([...matching].sort())
  };
}
