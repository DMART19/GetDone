export type ResourceType = "compute" | "gpu" | "storage" | "network" | "cloud" | "partner" | "other";
export type ResourceState =
  | "discovered"
  | "enrolling"
  | "profiling"
  | "validating"
  | "ready"
  | "degraded"
  | "saturated"
  | "draining"
  | "unreachable"
  | "failed"
  | "quarantined"
  | "maintenance"
  | "disabled";

export interface Resource {
  id: string;
  portfolioId: string;
  companyId: string;
  type: ResourceType;
  providerId?: string;
  poolId?: string;
  state: ResourceState;
  environmentPermissions: readonly ("development" | "staging" | "production")[];
  capabilityNames: readonly string[];
  failureDomainIds: readonly string[];
  credentialBindingIds: readonly string[];
  policyBindingIds: readonly string[];
  identityEvidenceIds: readonly string[];
  trustEvidenceIds: readonly string[];
  healthRecordIds: readonly string[];
  capabilityBindingIds: readonly string[];
  locationIds: readonly string[];
  costProfileIds: readonly string[];
  providerBindingIds: readonly string[];
  trustClass: "untrusted" | "development" | "restricted" | "production-eligible";
  dataClassesAllowed: readonly ("public" | "internal" | "customer" | "sensitive")[];
  region?: string;
  architecture?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ResourcePool {
  id: string;
  portfolioId: string;
  companyId: string;
  name: string;
  resourceIds: readonly string[];
  capabilityNames: readonly string[];
  failureDomainIds: readonly string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface PlacementRequest {
  id: string;
  portfolioId: string;
  companyId: string;
  jobId: string;
  status: "requested" | "evaluating" | "decided" | "cancelled";
  requiredCapabilities: readonly string[];
  cpuCores?: number;
  memoryMb?: number;
  gpuCount?: number;
  vramMb?: number;
  architecture?: string;
  environment: "development" | "staging" | "production";
  dataClass: "public" | "internal" | "customer" | "sensitive";
  allowedRegions?: readonly string[];
  reliabilityTier?: "best-effort" | "standard" | "high";
  maxJobCostCents?: number;
  fallbackRequired?: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface PlacementDecision {
  id: string;
  portfolioId: string;
  companyId: string;
  placementRequestId: string;
  status: "proposed" | "accepted" | "rejected";
  selectedResourceId?: string;
  selectedPoolId?: string;
  eligibleCandidateIds: readonly string[];
  rejectedCandidates: ReadonlyArray<{ candidateId: string; reasons: readonly string[] }>;
  rationale: readonly string[];
  decidedAt?: string;
  version: number;
}

export interface Reservation {
  id: string;
  portfolioId: string;
  companyId: string;
  placementRequestId: string;
  placementDecisionId?: string;
  resourceId?: string;
  poolId?: string;
  state: "requested" | "active" | "rejected" | "released" | "expired" | "cancelled";
  capacity: Readonly<Record<string, number>>;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface Allocation {
  id: string;
  portfolioId: string;
  companyId: string;
  jobId: string;
  reservationId: string;
  resourceId?: string;
  poolId?: string;
  status: "pending" | "active" | "releasing" | "released" | "failed";
  startedAt?: string;
  releasedAt?: string;
  version: number;
}

export interface Failover {
  id: string;
  portfolioId: string;
  companyId: string;
  jobId?: string;
  sourceResourceId?: string;
  sourcePoolId?: string;
  targetResourceId?: string;
  targetPoolId?: string;
  reason: string;
  status: "proposed" | "authorized" | "running" | "verified" | "failed" | "cancelled";
  evidenceIds: readonly string[];
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ResourceIncident {
  id: string;
  portfolioId: string;
  companyId: string;
  resourceId?: string;
  poolId?: string;
  failureDomainId?: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "open" | "investigating" | "mitigated" | "resolved";
  signalIds: readonly string[];
  summary: string;
  openedAt: string;
  resolvedAt?: string;
  version: number;
}


export type ResourceHealthStatus =
  | "healthy"
  | "degraded"
  | "saturated"
  | "draining"
  | "unreachable"
  | "failed"
  | "quarantined"
  | "maintenance";

export interface ResourceScopedEvidence {
  id: string;
  resourceId: string;
  portfolioId: string;
  companyId: string;
  observedAt: string;
  expiresAt?: string;
}

export interface ResourceIdentityEvidence extends ResourceScopedEvidence {
  identityType: "agent-key" | "provider-account" | "hardware-attestation" | "manual";
  subject: string;
  verifier: string;
  verified: boolean;
  publicKeyFingerprint?: string;
}

export interface ResourceTrustEvidence extends ResourceScopedEvidence {
  trustClass: Resource["trustClass"];
  verifiedBy: string;
  reason: string;
  evidenceIds: readonly string[];
}

export interface ResourceHealthRecord extends ResourceScopedEvidence {
  status: ResourceHealthStatus;
  method: string;
  source: string;
  freshnessSeconds: number;
}

export interface ResourceCapabilityBinding extends ResourceScopedEvidence {
  capabilityName: string;
  adapterBinding: string;
  validated: boolean;
  evidenceIds: readonly string[];
}

export interface ResourceLocation extends ResourceScopedEvidence {
  locationClass: "home" | "office" | "cloud" | "colo" | "partner-dc";
  region?: string;
  site?: string;
  failureDomainIds: readonly string[];
}

export interface ResourceCostProfile extends ResourceScopedEvidence {
  currency: string;
  fixedMonthlyCents?: number;
  estimatedHourlyCents?: number;
  marginalHourlyCents?: number;
  source: string;
}

export interface ResourceProviderBinding extends ResourceScopedEvidence {
  providerId: string;
  adapterId: string;
  adapterVersion: string;
  authenticated: boolean;
  status: "active" | "degraded" | "revoked" | "unavailable";
}

export interface ResourceRegistryEvidenceSnapshot {
  identities: readonly ResourceIdentityEvidence[];
  trust: readonly ResourceTrustEvidence[];
  health: readonly ResourceHealthRecord[];
  capabilities: readonly ResourceCapabilityBinding[];
  locations: readonly ResourceLocation[];
  costs: readonly ResourceCostProfile[];
  providers: readonly ResourceProviderBinding[];
}

export interface ResourceReadinessResult {
  ready: boolean;
  reasons: readonly string[];
}

function evidenceInScope(
  item: ResourceScopedEvidence,
  resource: Resource,
  now: number
) {
  return (
    item.resourceId === resource.id
    && item.portfolioId === resource.portfolioId
    && item.companyId === resource.companyId
    && Date.parse(item.observedAt) <= now
    && (!item.expiresAt || Date.parse(item.expiresAt) > now)
  );
}

export function evaluateResourceReadiness(
  resource: Resource,
  evidence: ResourceRegistryEvidenceSnapshot,
  now = Date.now()
): ResourceReadinessResult {
  const reasons: string[] = [];

  const identities = evidence.identities.filter((item) => evidenceInScope(item, resource, now));
  const trust = evidence.trust.filter((item) => evidenceInScope(item, resource, now));
  const health = evidence.health.filter((item) => evidenceInScope(item, resource, now));
  const capabilities = evidence.capabilities.filter((item) => evidenceInScope(item, resource, now));
  const latestCapabilities = new Map<string, ResourceCapabilityBinding>();
  for (const capability of [...capabilities].sort((left, right) => {
    const observed = Date.parse(right.observedAt) - Date.parse(left.observedAt);
    return observed !== 0 ? observed : right.id.localeCompare(left.id);
  })) {
    if (!latestCapabilities.has(capability.capabilityName)) {
      latestCapabilities.set(capability.capabilityName, capability);
    }
  }
  const locations = evidence.locations.filter((item) => evidenceInScope(item, resource, now));
  const providers = evidence.providers.filter((item) => evidenceInScope(item, resource, now));

  if (!identities.some((item) => item.verified)) {
    reasons.push("verified-resource-identity-required");
  }

  if (
    resource.trustClass === "untrusted"
    || !trust.some((item) => item.trustClass === resource.trustClass)
  ) {
    reasons.push("verified-trust-classification-required");
  }

  const freshHealth = health
    .filter((item) => Number.isFinite(item.freshnessSeconds) && item.freshnessSeconds >= 0)
    .filter((item) => now - Date.parse(item.observedAt) <= item.freshnessSeconds * 1000);
  if (!freshHealth.some((item) => item.status === "healthy")) {
    reasons.push("fresh-healthy-status-required");
  }

  for (const capabilityName of resource.capabilityNames) {
    const latest = latestCapabilities.get(capabilityName);
    if (!latest?.validated || !latest.adapterBinding) {
      reasons.push("validated-capability-required:" + capabilityName);
    }
  }

  if (locations.length === 0) {
    reasons.push("verified-location-required");
  }
  if (resource.environmentPermissions.length === 0) {
    reasons.push("environment-permission-required");
  }
  if (resource.policyBindingIds.length === 0) {
    reasons.push("resource-policy-binding-required");
  }
  if (!providers.some((item) => item.authenticated && item.status === "active")) {
    reasons.push("active-provider-adapter-binding-required");
  }

  return {
    ready: reasons.length === 0,
    reasons: Object.freeze(reasons)
  };
}

export interface ResourceRegistryReadModel {
  id: string;
  portfolioId: string;
  companyId: string;
  type: ResourceType;
  state: ResourceState;
  trustClass: Resource["trustClass"];
  environmentPermissions: Resource["environmentPermissions"];
  capabilityNames: readonly string[];
  latestHealth?: ResourceHealthRecord;
  primaryLocation?: ResourceLocation;
  activeProviderBindings: readonly ResourceProviderBinding[];
  costProfiles: readonly ResourceCostProfile[];
  readiness: ResourceReadinessResult;
}

export function buildResourceRegistryReadModel(
  resource: Resource,
  evidence: ResourceRegistryEvidenceSnapshot,
  now = Date.now()
): ResourceRegistryReadModel {
  const latestHealth = evidence.health
    .filter((item) => evidenceInScope(item, resource, now))
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];
  const primaryLocation = evidence.locations
    .filter((item) => evidenceInScope(item, resource, now))
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];

  return Object.freeze({
    id: resource.id,
    portfolioId: resource.portfolioId,
    companyId: resource.companyId,
    type: resource.type,
    state: resource.state,
    trustClass: resource.trustClass,
    environmentPermissions: Object.freeze([...resource.environmentPermissions]),
    capabilityNames: Object.freeze([...resource.capabilityNames]),
    latestHealth,
    primaryLocation,
    activeProviderBindings: Object.freeze(
      evidence.providers.filter(
        (item) =>
          evidenceInScope(item, resource, now)
          && item.authenticated
          && item.status === "active"
      )
    ),
    costProfiles: Object.freeze(
      evidence.costs.filter((item) => evidenceInScope(item, resource, now))
    ),
    readiness: evaluateResourceReadiness(resource, evidence, now)
  });
}
