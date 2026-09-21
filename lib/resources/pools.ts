import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type {
  ResourceDataClass,
  ResourceReliabilityTier
} from "@/lib/resources/policy";

export const RESOURCE_POOL_CONTRACT_VERSION = "1.1.0";

export type GovernedResourcePoolState =
  | "discovered"
  | "enrolling"
  | "profiling"
  | "validating"
  | "ready"
  | "degraded"
  | "draining"
  | "unreachable"
  | "failed"
  | "quarantined"
  | "maintenance"
  | "disabled";

export interface GovernedResourcePool {
  id: string;
  portfolioId: string;
  companyId: string;
  displayName: string;
  providerId: string;
  adapterId: string;
  adapterVersion: string;
  state: GovernedResourcePoolState;
  environmentPermissions: readonly TrustedExecutionScope["environment"][];
  capabilityClasses: readonly string[];
  dataClassesAllowed: readonly ResourceDataClass[];
  reliabilityTier: ResourceReliabilityTier;
  region?: string;
  failureDomainIds: readonly string[];
  credentialBindingIds: readonly string[];
  policyBindingIds: readonly string[];
  autoSchedulingEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
  poolHash: string;
}

export interface ResourcePoolCapacitySnapshot {
  poolId: string;
  totalCapacity: Readonly<Record<string, number>>;
  usedCapacity: Readonly<Record<string, number>>;
  reservedCapacity: Readonly<Record<string, number>>;
  protectedHeadroom: Readonly<Record<string, number>>;
  quotaCapacity?: Readonly<Record<string, number>>;
  currentWorkloadIds: readonly string[];
  observedAt: string;
  expiresAt: string;
  snapshotHash: string;
}

export interface ResourcePoolReadinessEvidence {
  poolId: string;
  poolHash: string;
  providerId: string;
  adapterId: string;
  adapterVersion: string;
  adapterAuthenticated: boolean;
  identityVerified: boolean;
  capabilitiesValidated: boolean;
  healthVerified: boolean;
  aggregateCapacityVerified: boolean;
  failureDomainsVerified: boolean;
  costModelVerified: boolean;
  credentialBindingsScoped: boolean;
  observedAt: string;
  expiresAt: string;
  evidenceHash: string;
}

export interface ResourcePoolReadiness {
  poolId: string;
  poolHash: string;
  evidenceHash: string;
  evaluatedAt: string;
  ready: boolean;
  reasons: readonly string[];
  readinessHash: string;
}

export interface ResourcePoolReadModel {
  id: string;
  displayName: string;
  state: GovernedResourcePoolState;
  providerId: string;
  region?: string;
  environments: readonly TrustedExecutionScope["environment"][];
  capabilityClasses: readonly string[];
  dataClassesAllowed: readonly ResourceDataClass[];
  reliabilityTier: ResourceReliabilityTier;
  autoSchedulingEnabled: boolean;
  health: "healthy" | "degraded" | "unavailable";
  utilization: Readonly<Record<string, number>>;
  totalCapacity: Readonly<Record<string, number>>;
  protectedHeadroom: Readonly<Record<string, number>>;
  currentWorkloadCount: number;
  costSummary: string;
  failureDomainIds: readonly string[];
  readiness: ResourcePoolReadiness;
}

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

function normalizeVector(vector: Readonly<Record<string, number>>, label: string) {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(vector).sort(([a], [b]) => a.localeCompare(b))) {
    if (!key || !Number.isFinite(value) || value < 0) {
      throw new ControlPlaneError("VALIDATION_FAILED", `${label} contains invalid capacity`);
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

function value(vector: Readonly<Record<string, number>>, key: string) {
  return vector[key] ?? 0;
}

function assertPoolIntegrity(pool: GovernedResourcePool) {
  const { poolHash, ...base } = pool;
  if (sha256Hex(base) !== poolHash) {
    throw new ControlPlaneError("FORBIDDEN", "Resource pool integrity check failed");
  }
  return pool;
}

function assertReadinessIntegrity(readiness: ResourcePoolReadiness, pool: GovernedResourcePool) {
  const { readinessHash, ...base } = readiness;
  if (
    sha256Hex(base) !== readinessHash
    || readiness.poolId !== pool.id
    || readiness.poolHash !== pool.poolHash
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Resource pool readiness is forged or belongs to another pool");
  }
  return readiness;
}

export function createGovernedResourcePool(
  input: Omit<GovernedResourcePool, "poolHash">
): GovernedResourcePool {
  if (
    !input.id
    || !input.portfolioId
    || !input.companyId
    || !input.displayName
    || !input.providerId
    || !input.adapterId
    || !input.adapterVersion
  ) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Resource pool identity/provider binding is required");
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Resource pool version must be positive");
  }
  if (input.environmentPermissions.length === 0 || input.capabilityClasses.length === 0) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Resource pool requires environment permissions and capability classes"
    );
  }
  const createdAt = parseTime(input.createdAt, "pool createdAt");
  const updatedAt = parseTime(input.updatedAt, "pool updatedAt");
  if (updatedAt < createdAt) {
    throw new ControlPlaneError("CONFLICT", "Resource pool updatedAt cannot precede createdAt");
  }
  const base = {
    ...input,
    environmentPermissions: Object.freeze([...new Set(input.environmentPermissions)].sort()),
    capabilityClasses: Object.freeze([...new Set(input.capabilityClasses)].sort()),
    dataClassesAllowed: Object.freeze([...new Set(input.dataClassesAllowed)].sort()),
    failureDomainIds: Object.freeze([...new Set(input.failureDomainIds)].sort()),
    credentialBindingIds: Object.freeze([...new Set(input.credentialBindingIds)].sort()),
    policyBindingIds: Object.freeze([...new Set(input.policyBindingIds)].sort()),
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString()
  };
  return Object.freeze({ ...base, poolHash: sha256Hex(base) });
}

export function createResourcePoolCapacitySnapshot(
  input: Omit<ResourcePoolCapacitySnapshot, "snapshotHash">
): ResourcePoolCapacitySnapshot {
  const total = normalizeVector(input.totalCapacity, "totalCapacity");
  const used = normalizeVector(input.usedCapacity, "usedCapacity");
  const reserved = normalizeVector(input.reservedCapacity, "reservedCapacity");
  const headroom = normalizeVector(input.protectedHeadroom, "protectedHeadroom");
  const quota = input.quotaCapacity
    ? normalizeVector(input.quotaCapacity, "quotaCapacity")
    : undefined;
  const dimensions = new Set([
    ...Object.keys(total),
    ...Object.keys(used),
    ...Object.keys(reserved),
    ...Object.keys(headroom),
    ...Object.keys(quota ?? {})
  ]);
  for (const dimension of dimensions) {
    if (value(used, dimension) + value(reserved, dimension) + value(headroom, dimension) > value(total, dimension)) {
      throw new ControlPlaneError("CONFLICT", `Pool capacity exceeds total: ${dimension}`);
    }
    if (quota && value(total, dimension) > value(quota, dimension)) {
      throw new ControlPlaneError("POLICY_BLOCKED", `Pool total capacity exceeds quota: ${dimension}`);
    }
  }
  const observedAt = parseTime(input.observedAt, "pool capacity observedAt");
  const expiresAt = parseTime(input.expiresAt, "pool capacity expiresAt");
  if (expiresAt <= observedAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Pool capacity expiry must follow observation");
  }
  const base = {
    poolId: input.poolId,
    totalCapacity: total,
    usedCapacity: used,
    reservedCapacity: reserved,
    protectedHeadroom: headroom,
    quotaCapacity: quota,
    currentWorkloadIds: Object.freeze([...new Set(input.currentWorkloadIds)].sort()),
    observedAt: new Date(observedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString()
  };
  return Object.freeze({ ...base, snapshotHash: sha256Hex(base) });
}

export function createResourcePoolReadinessEvidence(
  input: Omit<ResourcePoolReadinessEvidence, "evidenceHash">
): ResourcePoolReadinessEvidence {
  if (
    !input.poolId
    || !input.poolHash
    || !input.providerId
    || !input.adapterId
    || !input.adapterVersion
  ) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Resource pool readiness evidence lineage is required");
  }
  const observedAt = parseTime(input.observedAt, "pool readiness observedAt");
  const expiresAt = parseTime(input.expiresAt, "pool readiness expiresAt");
  if (expiresAt <= observedAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Pool readiness evidence expiry must follow observation");
  }
  const base = {
    ...input,
    observedAt: new Date(observedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString()
  };
  return Object.freeze({ ...base, evidenceHash: sha256Hex(base) });
}

export function evaluateResourcePoolReadiness(input: {
  pool: GovernedResourcePool;
  evidence: ResourcePoolReadinessEvidence;
  evaluatedAt: string;
}): ResourcePoolReadiness {
  assertPoolIntegrity(input.pool);
  const { evidenceHash, ...evidenceBase } = input.evidence;
  const evaluatedAt = parseTime(input.evaluatedAt, "pool readiness evaluatedAt");
  if (
    sha256Hex(evidenceBase) !== evidenceHash
    || input.evidence.poolId !== input.pool.id
    || input.evidence.poolHash !== input.pool.poolHash
    || input.evidence.providerId !== input.pool.providerId
    || input.evidence.adapterId !== input.pool.adapterId
    || input.evidence.adapterVersion !== input.pool.adapterVersion
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Resource pool readiness evidence is forged or outside pool/provider/adapter lineage"
    );
  }
  if (
    Date.parse(input.evidence.observedAt) > evaluatedAt
    || Date.parse(input.evidence.expiresAt) <= evaluatedAt
  ) {
    throw new ControlPlaneError("UNAVAILABLE", "Resource pool readiness evidence is stale or from the future");
  }

  const reasons: string[] = [];
  const e = input.evidence;
  if (!e.identityVerified) reasons.push("pool-identity-not-verified");
  if (!e.adapterAuthenticated) reasons.push("pool-adapter-not-authenticated");
  if (!e.capabilitiesValidated) reasons.push("pool-capabilities-not-validated");
  if (!e.healthVerified) reasons.push("pool-health-not-verified");
  if (!e.aggregateCapacityVerified) reasons.push("pool-capacity-not-verified");
  if (!e.failureDomainsVerified) reasons.push("pool-failure-domains-not-verified");
  if (!e.costModelVerified) reasons.push("pool-cost-model-not-verified");
  if (!e.credentialBindingsScoped) reasons.push("pool-credentials-not-scoped");
  if (input.pool.policyBindingIds.length === 0) reasons.push("pool-policy-binding-required");
  if (input.pool.credentialBindingIds.length === 0) reasons.push("pool-credential-binding-required");
  if (input.pool.failureDomainIds.length === 0) reasons.push("pool-failure-domain-required");

  const readinessBase = {
    poolId: input.pool.id,
    poolHash: input.pool.poolHash,
    evidenceHash,
    evaluatedAt: new Date(evaluatedAt).toISOString(),
    ready: reasons.length === 0,
    reasons: Object.freeze(reasons)
  };
  return Object.freeze({ ...readinessBase, readinessHash: sha256Hex(readinessBase) });
}

export function assertResourcePoolEligible(input: {
  pool: GovernedResourcePool;
  scope: Pick<TrustedExecutionScope, "portfolioId" | "companyId" | "environment">;
  dataClass: ResourceDataClass;
  capability: string;
  readiness: ResourcePoolReadiness;
}) {
  const { pool, scope } = input;
  assertPoolIntegrity(pool);
  assertReadinessIntegrity(input.readiness, pool);
  if (
    pool.portfolioId !== scope.portfolioId
    || pool.companyId !== scope.companyId
    || !pool.environmentPermissions.includes(scope.environment)
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Resource pool is outside trusted scope/environment");
  }
  if (pool.state !== "ready" || !input.readiness.ready || !pool.autoSchedulingEnabled) {
    throw new ControlPlaneError("UNAVAILABLE", "Resource pool is not ready for autonomous scheduling");
  }
  if (!pool.dataClassesAllowed.includes(input.dataClass)) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Resource pool data policy rejects this workload");
  }
  if (!pool.capabilityClasses.includes(input.capability)) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Resource pool lacks required capability class");
  }
  return pool;
}

export function buildResourcePoolReadModel(input: {
  pool: GovernedResourcePool;
  capacity: ResourcePoolCapacitySnapshot;
  readiness: ResourcePoolReadiness;
  estimatedHourlyCents?: number;
  evaluatedAt: string;
}): ResourcePoolReadModel {
  assertPoolIntegrity(input.pool);
  assertReadinessIntegrity(input.readiness, input.pool);
  const evaluatedAt = parseTime(input.evaluatedAt, "pool read model evaluatedAt");
  const { snapshotHash, ...capacityBase } = input.capacity;
  if (sha256Hex(capacityBase) !== snapshotHash || input.capacity.poolId !== input.pool.id) {
    throw new ControlPlaneError("FORBIDDEN", "Pool capacity snapshot integrity/scope check failed");
  }
  if (Date.parse(input.capacity.observedAt) > evaluatedAt || Date.parse(input.capacity.expiresAt) <= evaluatedAt) {
    throw new ControlPlaneError("UNAVAILABLE", "Pool capacity snapshot is stale or from the future");
  }
  if (Date.parse(input.readiness.evaluatedAt) > evaluatedAt) {
    throw new ControlPlaneError("UNAVAILABLE", "Pool readiness is from the future");
  }
  const utilization: Record<string, number> = {};
  for (const [dimension, total] of Object.entries(input.capacity.totalCapacity)) {
    utilization[dimension] = total === 0
      ? 0
      : Number((value(input.capacity.usedCapacity, dimension) / total).toFixed(6));
  }
  const health =
    input.pool.state === "ready"
      ? "healthy"
      : input.pool.state === "degraded" || input.pool.state === "draining"
        ? "degraded"
        : "unavailable";
  return Object.freeze({
    id: input.pool.id,
    displayName: input.pool.displayName,
    state: input.pool.state,
    providerId: input.pool.providerId,
    region: input.pool.region,
    environments: input.pool.environmentPermissions,
    capabilityClasses: input.pool.capabilityClasses,
    dataClassesAllowed: input.pool.dataClassesAllowed,
    reliabilityTier: input.pool.reliabilityTier,
    autoSchedulingEnabled: input.pool.autoSchedulingEnabled,
    health,
    utilization: Object.freeze(utilization),
    totalCapacity: input.capacity.totalCapacity,
    protectedHeadroom: input.capacity.protectedHeadroom,
    currentWorkloadCount: input.capacity.currentWorkloadIds.length,
    costSummary: input.estimatedHourlyCents === undefined
      ? "cost-unavailable"
      : `estimated-${input.estimatedHourlyCents}-cents-per-hour`,
    failureDomainIds: input.pool.failureDomainIds,
    readiness: input.readiness
  });
}
