import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type {
  ResourceDataClass,
  ResourceLocationClass,
  ResourceReliabilityTier
} from "@/lib/resources/policy";

export const STORAGE_FABRIC_CONTRACT_VERSION = "1.1.0";

export type StorageCopyRole =
  | "authoritative-primary"
  | "authoritative-secondary"
  | "cache"
  | "artifact"
  | "backup"
  | "archive"
  | "temporary"
  | "rebuildable";

export interface StorageDataObject {
  id: string;
  scope: Pick<TrustedExecutionScope, "portfolioId" | "companyId" | "environment">;
  dataClass: ResourceDataClass;
  authoritative: boolean;
  rebuildable: boolean;
  retentionDays: number;
  requiredRegions?: readonly string[];
  replicationFactor: number;
  recoveryPointObjectiveSeconds: number;
  recoveryTimeObjectiveSeconds: number;
  objectHash: string;
}

export interface StorageResourceSnapshot {
  id: string;
  portfolioId: string;
  companyId: string;
  environmentPermissions: readonly TrustedExecutionScope["environment"][];
  locationClass: ResourceLocationClass;
  region?: string;
  failureDomainIds: readonly string[];
  reliabilityTier: ResourceReliabilityTier;
  capacityBytes: number;
  availableBytes: number;
  encryptedAtRest: boolean;
  encryptedInTransit: boolean;
  durabilityClass: "ephemeral" | "standard" | "durable" | "archive";
  supportsAuthoritative: boolean;
  supportsBackup: boolean;
  supportsArchive: boolean;
  recoveryPointObjectiveSeconds: number;
  recoveryTimeObjectiveSeconds: number;
  state: "ready" | "degraded" | "draining" | "unreachable" | "failed" | "disabled";
  observedAt: string;
  expiresAt: string;
  snapshotHash: string;
}

export interface StoragePlacementCandidateResult {
  resourceId: string;
  eligible: boolean;
  rejectionReasons: readonly string[];
  preferenceHints: readonly string[];
  snapshotHash: string;
}

export interface StorageCopyPlan {
  id: string;
  dataObjectId: string;
  dataObjectHash: string;
  scope: Pick<TrustedExecutionScope, "portfolioId" | "companyId" | "environment">;
  copies: readonly Readonly<{
    resourceId: string;
    resourceSnapshotHash: string;
    role: StorageCopyRole;
    failureDomainIds: readonly string[];
    locationClass: ResourceLocationClass;
    region?: string;
  }>[];
  authoritativeCopyCount: number;
  distinctFailureDomainCount: number;
  createdAt: string;
  planHash: string;
}

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

function nonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be non-negative`);
  }
}

export function createStorageDataObject(
  input: Omit<StorageDataObject, "objectHash">
): StorageDataObject {
  if (!input.id || !input.scope.portfolioId || !input.scope.companyId) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Storage object identity and scope are required");
  }
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Storage retentionDays must be non-negative");
  }
  if (!Number.isInteger(input.replicationFactor) || input.replicationFactor < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Storage replicationFactor must be at least 1");
  }
  nonNegative(input.recoveryPointObjectiveSeconds, "RPO");
  nonNegative(input.recoveryTimeObjectiveSeconds, "RTO");
  if (input.authoritative && input.rebuildable) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Authoritative durable state cannot be declared rebuildable"
    );
  }
  const base = {
    ...input,
    requiredRegions: input.requiredRegions
      ? Object.freeze([...new Set(input.requiredRegions)].sort())
      : undefined
  };
  return Object.freeze({ ...base, objectHash: sha256Hex(base) });
}

export function createStorageResourceSnapshot(
  input: Omit<StorageResourceSnapshot, "snapshotHash">
): StorageResourceSnapshot {
  nonNegative(input.capacityBytes, "Storage capacity");
  nonNegative(input.availableBytes, "Storage available capacity");
  if (input.availableBytes > input.capacityBytes) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Available storage exceeds total capacity");
  }
  nonNegative(input.recoveryPointObjectiveSeconds, "Storage RPO");
  nonNegative(input.recoveryTimeObjectiveSeconds, "Storage RTO");
  const observedAt = parseTime(input.observedAt, "Storage snapshot observedAt");
  const expiresAt = parseTime(input.expiresAt, "Storage snapshot expiresAt");
  if (expiresAt <= observedAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Storage snapshot expiry must follow observation");
  }
  const base = {
    ...input,
    environmentPermissions: Object.freeze([...new Set(input.environmentPermissions)].sort()),
    failureDomainIds: Object.freeze([...new Set(input.failureDomainIds)].sort()),
    observedAt: new Date(observedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString()
  };
  return Object.freeze({ ...base, snapshotHash: sha256Hex(base) });
}

export function evaluateStoragePlacement(input: {
  object: StorageDataObject;
  candidate: StorageResourceSnapshot;
  requiredBytes: number;
  role: StorageCopyRole;
  evaluatedAt: string;
  preferredRegion?: string;
}): StoragePlacementCandidateResult {
  const { object, candidate, role } = input;
  const objectBase = { ...object } as Record<string, unknown>;
  delete objectBase.objectHash;
  if (sha256Hex(objectBase) !== object.objectHash) {
    throw new ControlPlaneError("FORBIDDEN", "Storage object integrity check failed");
  }
  const { snapshotHash, ...snapshotBase } = candidate;
  if (sha256Hex(snapshotBase) !== snapshotHash) {
    throw new ControlPlaneError("FORBIDDEN", "Storage resource snapshot integrity check failed");
  }

  const evaluatedAt = parseTime(input.evaluatedAt, "Storage placement evaluatedAt");
  nonNegative(input.requiredBytes, "Required storage");
  const reasons: string[] = [];
  const hints: string[] = [];

  if (
    candidate.portfolioId !== object.scope.portfolioId
    || candidate.companyId !== object.scope.companyId
  ) reasons.push("scope-mismatch");
  if (!candidate.environmentPermissions.includes(object.scope.environment)) {
    reasons.push("environment-not-allowed");
  }
  if (Date.parse(candidate.observedAt) > evaluatedAt || Date.parse(candidate.expiresAt) <= evaluatedAt) {
    reasons.push("snapshot-stale-or-future");
  }
  if (!["ready", "degraded"].includes(candidate.state)) reasons.push("storage-not-admissible");
  if (!candidate.encryptedAtRest || !candidate.encryptedInTransit) reasons.push("encryption-required");
  if (candidate.availableBytes < input.requiredBytes) reasons.push("insufficient-capacity");
  if (
    object.requiredRegions?.length
    && (!candidate.region || !object.requiredRegions.includes(candidate.region))
  ) reasons.push("residency-region-not-allowed");
  if (candidate.recoveryPointObjectiveSeconds > object.recoveryPointObjectiveSeconds) {
    reasons.push("rpo-too-weak");
  }
  if (candidate.recoveryTimeObjectiveSeconds > object.recoveryTimeObjectiveSeconds) {
    reasons.push("rto-too-weak");
  }

  const authoritativeRole = role === "authoritative-primary" || role === "authoritative-secondary";
  if (authoritativeRole && !object.authoritative) reasons.push("object-is-not-authoritative");
  if (authoritativeRole && !candidate.supportsAuthoritative) reasons.push("authoritative-role-not-supported");
  if (role === "backup" && !candidate.supportsBackup) reasons.push("backup-role-not-supported");
  if (role === "archive" && !candidate.supportsArchive) reasons.push("archive-role-not-supported");

  const productionCriticalLike =
    object.scope.environment === "production"
    && ["CUSTOMER", "SENSITIVE", "PRODUCTION_CRITICAL"].includes(object.dataClass);
  if (candidate.locationClass === "HOME" && authoritativeRole && productionCriticalLike) {
    reasons.push("home-cannot-be-unqualified-production-authority");
  }
  if (
    candidate.locationClass === "HOME"
    && role === "authoritative-primary"
    && object.replicationFactor < 2
  ) {
    reasons.push("home-cannot-hold-sole-authoritative-copy");
  }

  if (input.preferredRegion && candidate.region === input.preferredRegion) {
    hints.push("preferred-data-locality");
  }
  if (candidate.locationClass === "HOME") hints.push("home-secondary-or-rebuildable-preferred");
  if (candidate.reliabilityTier === "HIGH" || candidate.reliabilityTier === "CRITICAL") {
    hints.push("high-reliability-storage");
  }

  return Object.freeze({
    resourceId: candidate.id,
    eligible: reasons.length === 0,
    rejectionReasons: Object.freeze(reasons),
    preferenceHints: Object.freeze(hints),
    snapshotHash
  });
}

export function createStorageCopyPlan(input: {
  id: string;
  object: StorageDataObject;
  selections: readonly Readonly<{
    candidate: StorageResourceSnapshot;
    role: StorageCopyRole;
  }>[];
  requiredBytes: number;
  createdAt: string;
}): StorageCopyPlan {
  if (input.selections.length < input.object.replicationFactor) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Storage plan does not meet minimum copy count");
  }
  const createdAtMs = parseTime(input.createdAt, "Storage copy plan createdAt");
  const seen = new Set<string>();
  const copies = input.selections.map(({ candidate, role }) => {
    if (seen.has(candidate.id)) {
      throw new ControlPlaneError("CONFLICT", "Storage copy plan cannot duplicate a resource");
    }
    seen.add(candidate.id);
    const evaluation = evaluateStoragePlacement({
      object: input.object,
      candidate,
      requiredBytes: input.requiredBytes,
      role,
      evaluatedAt: new Date(createdAtMs).toISOString()
    });
    if (!evaluation.eligible) {
      throw new ControlPlaneError(
        "POLICY_BLOCKED",
        `Storage copy candidate rejected: ${evaluation.rejectionReasons.join(",")}`
      );
    }
    return Object.freeze({
      resourceId: candidate.id,
      resourceSnapshotHash: candidate.snapshotHash,
      role,
      failureDomainIds: Object.freeze([...candidate.failureDomainIds]),
      locationClass: candidate.locationClass,
      region: candidate.region
    });
  });

  const authoritativeCopies = copies.filter(
    (copy) => copy.role === "authoritative-primary" || copy.role === "authoritative-secondary"
  );
  if (input.object.authoritative) {
    if (authoritativeCopies.length < input.object.replicationFactor) {
      throw new ControlPlaneError(
        "POLICY_BLOCKED",
        "Authoritative replication factor must be satisfied by authoritative copies"
      );
    }
    const primaryCount = authoritativeCopies.filter(
      (copy) => copy.role === "authoritative-primary"
    ).length;
    if (primaryCount !== 1) {
      throw new ControlPlaneError(
        "POLICY_BLOCKED",
        "Authoritative storage plan requires exactly one authoritative primary"
      );
    }
  } else if (authoritativeCopies.length > 0) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Non-authoritative objects cannot receive authoritative copy roles"
    );
  }
  if (
    input.object.scope.environment === "production"
    && input.object.authoritative
    && authoritativeCopies.every((copy) => copy.locationClass === "HOME")
  ) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Production authoritative state cannot depend only on HOME storage"
    );
  }
  for (const copy of authoritativeCopies) {
    if (copy.failureDomainIds.length === 0) {
      throw new ControlPlaneError(
        "POLICY_BLOCKED",
        "Authoritative copies require explicit failure-domain membership"
      );
    }
  }
  for (let left = 0; left < authoritativeCopies.length; left += 1) {
    const leftDomains = new Set(authoritativeCopies[left].failureDomainIds);
    for (let right = left + 1; right < authoritativeCopies.length; right += 1) {
      const shared = authoritativeCopies[right].failureDomainIds.filter((id) => leftDomains.has(id));
      if (shared.length > 0) {
        throw new ControlPlaneError(
          "POLICY_BLOCKED",
          `Authoritative replicas share a correlated failure domain: ${shared.join(",")}`
        );
      }
    }
  }
  const domains = new Set(authoritativeCopies.flatMap((copy) => copy.failureDomainIds));
  if (input.object.authoritative && input.object.replicationFactor > 1 && domains.size < 2) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Replicated authoritative state must span distinct failure domains"
    );
  }

  const base = {
    id: input.id,
    dataObjectId: input.object.id,
    dataObjectHash: input.object.objectHash,
    scope: input.object.scope,
    copies: Object.freeze(copies),
    authoritativeCopyCount: authoritativeCopies.length,
    distinctFailureDomainCount: domains.size,
    createdAt: new Date(createdAtMs).toISOString()
  };
  return Object.freeze({ ...base, planHash: sha256Hex(base) });
}

export function assertStorageCopyPlanIntegrity(plan: StorageCopyPlan) {
  const { planHash, ...base } = plan;
  if (sha256Hex(base) !== planHash) {
    throw new ControlPlaneError("FORBIDDEN", "Storage copy plan integrity check failed");
  }
  return plan;
}
