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
