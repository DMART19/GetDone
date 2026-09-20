import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import {
  evaluateResourcePolicy,
  type ResourceDataClass,
  type ResourcePolicy,
  type ResourcePolicyFacts,
  type ResourceReliabilityTier
} from "@/lib/resources/policy";

export interface PlacementComputeEnvelope {
  cpuCores: number;
  memoryMb: number;
  gpuCount?: number;
  vramMb?: number;
  architecture?: string;
}

export interface PlacementRequestRecord {
  id: string;
  source: "control-plane";
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  jobId: string;
  jobAuthorizationHash: string;
  status: "requested" | "evaluating" | "decided" | "cancelled" | "expired";
  requiredCapabilities: readonly string[];
  compute: PlacementComputeEnvelope;
  priority: "low" | "normal" | "high" | "critical";
  deadlineAt?: string;
  checkpointable: boolean;
  retryable: boolean;
  dataClass: ResourceDataClass;
  allowedRegions?: readonly string[];
  preferredLocality?: string;
  reliabilityTier: ResourceReliabilityTier;
  fallbackRequired: boolean;
  maxJobCostCents?: number;
  pinnedResourceId?: string;
  excludedResourceIds: readonly string[];
  idempotencyKey: string;
  createdAt: string;
  expiresAt: string;
  requestHash: string;
}

export interface PlacementCandidateSnapshot {
  resourceId: string;
  portfolioId: string;
  companyId: string;
  environmentPermissions: readonly TrustedExecutionScope["environment"][];
  locationClass: ResourcePolicyFacts["locationClass"];
  region?: string;
  reliabilityTier: ResourcePolicyFacts["reliabilityTier"];
  encryptedAtRest: boolean;
  encryptedInTransit: boolean;
  fallbackAvailable: boolean;
  interruptionClass: ResourcePolicyFacts["interruptionClass"];
  workloadClass: string;
  healthStatus: "healthy" | "degraded" | "saturated" | "draining" | "unreachable" | "failed" | "quarantined" | "maintenance";
  healthObservedAt: string;
  validatedCapabilities: readonly string[];
  architecture: string;
  profileExpiresAt: string;
  profileHash: string;
  availableCapacity: PlacementComputeEnvelope;
  capacityObservedAt: string;
  capacityExpiresAt: string;
  credentialAvailable: boolean;
  estimatedJobCostCents?: number;
  snapshotHash: string;
}

export interface PlacementCandidateResult {
  resourceId: string;
  eligible: boolean;
  rejectionReasons: readonly string[];
  policyReasons: readonly string[];
  explanation: readonly string[];
  snapshotHash: string;
}

export interface PlacementEvaluationReport {
  placementRequestId: string;
  evaluatedAt: string;
  eligibleCandidateIds: readonly string[];
  candidates: readonly PlacementCandidateResult[];
  reportHash: string;
}

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function requireNonNegative(value: number | undefined, label: string) {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be non-negative`);
  }
}

export function createPlacementRequest(input: {
  id: string;
  source: "control-plane" | "frontend" | "ai-model" | "provider";
  jobAuthorized: boolean;
  scope: TrustedExecutionScope;
  jobId: string;
  jobAuthorizationHash: string;
  requiredCapabilities: readonly string[];
  compute: PlacementComputeEnvelope;
  priority: PlacementRequestRecord["priority"];
  deadlineAt?: string;
  checkpointable: boolean;
  retryable: boolean;
  dataClass: ResourceDataClass;
  allowedRegions?: readonly string[];
  preferredLocality?: string;
  reliabilityTier: ResourceReliabilityTier;
  fallbackRequired: boolean;
  maxJobCostCents?: number;
  pinnedResourceId?: string;
  excludedResourceIds?: readonly string[];
  idempotencyKey: string;
  createdAt: string;
  expiresAt: string;
}): PlacementRequestRecord {
  if (input.source !== "control-plane" || !input.jobAuthorized) {
    throw new ControlPlaneError("FORBIDDEN", "Placement requests require an authorized control-plane job");
  }
  if (!input.id || !input.jobId || !input.jobAuthorizationHash || !input.idempotencyKey) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Placement request identity and authorization lineage are required");
  }
  if (input.requiredCapabilities.length === 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Placement request requires at least one capability");
  }

  requireNonNegative(input.compute.cpuCores, "CPU requirement");
  requireNonNegative(input.compute.memoryMb, "Memory requirement");
  requireNonNegative(input.compute.gpuCount, "GPU requirement");
  requireNonNegative(input.compute.vramMb, "VRAM requirement");
  requireNonNegative(input.maxJobCostCents, "Maximum job cost");
  if (input.compute.cpuCores < 0.01 || input.compute.memoryMb < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Placement request requires positive compute capacity");
  }

  const createdAt = parseTime(input.createdAt, "Placement createdAt");
  const expiresAt = parseTime(input.expiresAt, "Placement expiresAt");
  if (expiresAt <= createdAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Placement request expiry must follow creation");
  }
  if (input.deadlineAt && parseTime(input.deadlineAt, "Placement deadline") < createdAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Placement deadline cannot precede request creation");
  }

  const base: Omit<PlacementRequestRecord, "requestHash"> = {
    id: input.id,
    source: "control-plane",
    portfolioId: input.scope.portfolioId,
    companyId: input.scope.companyId,
    environment: input.scope.environment,
    jobId: input.jobId,
    jobAuthorizationHash: input.jobAuthorizationHash,
    status: "requested",
    requiredCapabilities: Object.freeze(uniqueSorted(input.requiredCapabilities)),
    compute: Object.freeze({ ...input.compute }),
    priority: input.priority,
    deadlineAt: input.deadlineAt,
    checkpointable: input.checkpointable,
    retryable: input.retryable,
    dataClass: input.dataClass,
    allowedRegions: input.allowedRegions
      ? Object.freeze(uniqueSorted(input.allowedRegions))
      : undefined,
    preferredLocality: input.preferredLocality,
    reliabilityTier: input.reliabilityTier,
    fallbackRequired: input.fallbackRequired,
    maxJobCostCents: input.maxJobCostCents,
    pinnedResourceId: input.pinnedResourceId,
    excludedResourceIds: Object.freeze(uniqueSorted(input.excludedResourceIds ?? [])),
    idempotencyKey: input.idempotencyKey,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString()
  };
  return Object.freeze({ ...base, requestHash: sha256Hex(base) });
}

export function createOrReuseActivePlacementRequest(
  existing: readonly PlacementRequestRecord[],
  candidate: PlacementRequestRecord,
  now = Date.now()
): { request: PlacementRequestRecord; reused: boolean } {
  const active = existing.find((item) =>
    item.portfolioId === candidate.portfolioId
    && item.companyId === candidate.companyId
    && item.idempotencyKey === candidate.idempotencyKey
    && ["requested", "evaluating"].includes(item.status)
    && Date.parse(item.expiresAt) > now
  );

  if (!active) return { request: candidate, reused: false };

  const comparable = (item: PlacementRequestRecord) => ({
    source: item.source,
    portfolioId: item.portfolioId,
    companyId: item.companyId,
    environment: item.environment,
    jobId: item.jobId,
    jobAuthorizationHash: item.jobAuthorizationHash,
    requiredCapabilities: item.requiredCapabilities,
    compute: item.compute,
    priority: item.priority,
    deadlineAt: item.deadlineAt,
    checkpointable: item.checkpointable,
    retryable: item.retryable,
    dataClass: item.dataClass,
    allowedRegions: item.allowedRegions,
    preferredLocality: item.preferredLocality,
    reliabilityTier: item.reliabilityTier,
    fallbackRequired: item.fallbackRequired,
    maxJobCostCents: item.maxJobCostCents,
    pinnedResourceId: item.pinnedResourceId,
    excludedResourceIds: item.excludedResourceIds,
    idempotencyKey: item.idempotencyKey
  });
  if (sha256Hex(comparable(active)) !== sha256Hex(comparable(candidate))) {
    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Placement idempotency key was reused with different logical requirements"
    );
  }
  return { request: active, reused: true };
}

export function createPlacementCandidateSnapshot(
  input: Omit<PlacementCandidateSnapshot, "snapshotHash">
): PlacementCandidateSnapshot {
  parseTime(input.healthObservedAt, "Candidate health observedAt");
  const capacityObservedAt = parseTime(input.capacityObservedAt, "Capacity observedAt");
  const capacityExpiresAt = parseTime(input.capacityExpiresAt, "Capacity expiresAt");
  const profileExpiresAt = parseTime(input.profileExpiresAt, "Profile expiresAt");
  if (capacityExpiresAt <= capacityObservedAt || profileExpiresAt <= capacityObservedAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Candidate snapshot freshness window is invalid");
  }
  requireNonNegative(input.availableCapacity.cpuCores, "Candidate CPU capacity");
  requireNonNegative(input.availableCapacity.memoryMb, "Candidate memory capacity");
  requireNonNegative(input.availableCapacity.gpuCount, "Candidate GPU capacity");
  requireNonNegative(input.availableCapacity.vramMb, "Candidate VRAM capacity");

  const base: Omit<PlacementCandidateSnapshot, "snapshotHash"> = {
    ...input,
    environmentPermissions: Object.freeze(uniqueSorted(input.environmentPermissions)),
    validatedCapabilities: Object.freeze(uniqueSorted(input.validatedCapabilities)),
    availableCapacity: Object.freeze({ ...input.availableCapacity })
  };
  return Object.freeze({ ...base, snapshotHash: sha256Hex(base) });
}

function assertCandidateIntegrity(candidate: PlacementCandidateSnapshot) {
  const { snapshotHash, ...base } = candidate;
  if (sha256Hex(base) !== snapshotHash) {
    throw new ControlPlaneError("FORBIDDEN", "Placement candidate snapshot integrity check failed");
  }
}

function enoughCapacity(requested: PlacementComputeEnvelope, available: PlacementComputeEnvelope) {
  return (
    available.cpuCores >= requested.cpuCores
    && available.memoryMb >= requested.memoryMb
    && (available.gpuCount ?? 0) >= (requested.gpuCount ?? 0)
    && (available.vramMb ?? 0) >= (requested.vramMb ?? 0)
  );
}

export function evaluatePlacementCandidates(input: {
  request: PlacementRequestRecord;
  candidates: readonly PlacementCandidateSnapshot[];
  policy: ResourcePolicy;
  now?: number;
  maxHealthAgeSeconds?: number;
}): PlacementEvaluationReport {
  const now = input.now ?? Date.now();
  const maxHealthAgeSeconds = input.maxHealthAgeSeconds ?? 120;
  const { requestHash, ...requestBase } = input.request;
  if (sha256Hex(requestBase) !== requestHash) {
    throw new ControlPlaneError("FORBIDDEN", "Placement request integrity check failed");
  }
  if (input.request.source !== "control-plane" || Date.parse(input.request.expiresAt) <= now) {
    throw new ControlPlaneError("FORBIDDEN", "Placement request is expired or not authoritative");
  }

  const candidateResults = [...input.candidates]
    .sort((a, b) => a.resourceId.localeCompare(b.resourceId))
    .map((candidate): PlacementCandidateResult => {
      assertCandidateIntegrity(candidate);
      const rejectionReasons: string[] = [];
      const explanation: string[] = [];

      if (
        candidate.portfolioId !== input.request.portfolioId
        || candidate.companyId !== input.request.companyId
      ) {
        rejectionReasons.push("scope:tenant-mismatch");
      }
      if (input.request.excludedResourceIds.includes(candidate.resourceId)) {
        rejectionReasons.push("scope:resource-explicitly-excluded");
      }
      if (
        input.request.pinnedResourceId
        && candidate.resourceId !== input.request.pinnedResourceId
      ) {
        rejectionReasons.push("scope:not-pinned-resource");
      }

      const policyResult = evaluateResourcePolicy(input.policy, {
        environment: input.request.environment,
        dataClass: input.request.dataClass,
        locationClass: candidate.locationClass,
        region: candidate.region,
        reliabilityTier: candidate.reliabilityTier,
        encryptedAtRest: candidate.encryptedAtRest,
        encryptedInTransit: candidate.encryptedInTransit,
        fallbackAvailable: candidate.fallbackAvailable,
        interruptionClass: candidate.interruptionClass,
        workloadClass: candidate.workloadClass
      });
      for (const reason of policyResult.reasons) {
        rejectionReasons.push(`policy:${reason}`);
      }
      if (
        input.request.allowedRegions
        && (!candidate.region || !input.request.allowedRegions.includes(candidate.region))
      ) {
        rejectionReasons.push("policy:request-region-not-allowed");
      }
      const reliabilityRank = {
        BEST_EFFORT: 0,
        STANDARD: 1,
        HIGH: 2,
        CRITICAL: 3
      } as const;
      if (
        reliabilityRank[candidate.reliabilityTier]
        < reliabilityRank[input.request.reliabilityTier]
      ) {
        rejectionReasons.push("policy:request-reliability-tier-too-low");
      }
      if (input.request.fallbackRequired && !candidate.fallbackAvailable) {
        rejectionReasons.push("policy:request-fallback-required");
      }

      const healthObservedAt = Date.parse(candidate.healthObservedAt);
      if (
        candidate.healthStatus !== "healthy"
        || !Number.isFinite(healthObservedAt)
        || healthObservedAt > now
        || now - healthObservedAt > maxHealthAgeSeconds * 1000
      ) {
        rejectionReasons.push("health:not-fresh-and-healthy");
      }

      if (Date.parse(candidate.profileExpiresAt) <= now) {
        rejectionReasons.push("capability:profile-expired");
      }
      for (const capability of input.request.requiredCapabilities) {
        if (!candidate.validatedCapabilities.includes(capability)) {
          rejectionReasons.push(`capability:missing:${capability}`);
        }
      }
      if (
        input.request.compute.architecture
        && candidate.architecture !== input.request.compute.architecture
      ) {
        rejectionReasons.push("capability:architecture-mismatch");
      }

      if (Date.parse(candidate.capacityExpiresAt) <= now) {
        rejectionReasons.push("capacity:snapshot-expired");
      } else if (!enoughCapacity(input.request.compute, candidate.availableCapacity)) {
        rejectionReasons.push("capacity:insufficient");
      }

      if (!candidate.environmentPermissions.includes(input.request.environment)) {
        rejectionReasons.push("credential-environment:environment-not-permitted");
      }
      if (!candidate.credentialAvailable) {
        rejectionReasons.push("credential-environment:credential-unavailable");
      }

      if (
        input.request.maxJobCostCents !== undefined
        && (
          candidate.estimatedJobCostCents === undefined
          || candidate.estimatedJobCostCents > input.request.maxJobCostCents
        )
      ) {
        rejectionReasons.push("cost:ceiling-exceeded-or-unknown");
      }

      if (rejectionReasons.length === 0) {
        explanation.push("eligible:trusted-scope");
        explanation.push("eligible:policy-hard-constraints-passed");
        explanation.push("eligible:fresh-healthy-resource");
        explanation.push("eligible:validated-capabilities-and-capacity");
        explanation.push("eligible:credential-and-environment-available");
        explanation.push("eligible:within-cost-ceiling");
      }

      return Object.freeze({
        resourceId: candidate.resourceId,
        eligible: rejectionReasons.length === 0,
        rejectionReasons: Object.freeze(rejectionReasons),
        policyReasons: policyResult.reasons,
        explanation: Object.freeze(explanation),
        snapshotHash: candidate.snapshotHash
      });
    });

  const eligibleCandidateIds = candidateResults
    .filter((candidate) => candidate.eligible)
    .map((candidate) => candidate.resourceId);

  const base: Omit<PlacementEvaluationReport, "reportHash"> = {
    placementRequestId: input.request.id,
    evaluatedAt: new Date(now).toISOString(),
    eligibleCandidateIds: Object.freeze(eligibleCandidateIds),
    candidates: Object.freeze(candidateResults)
  };
  return Object.freeze({ ...base, reportHash: sha256Hex(base) });
}
