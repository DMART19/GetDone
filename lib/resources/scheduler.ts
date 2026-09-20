import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type {
  PlacementEvaluationReport,
  PlacementRequestRecord
} from "@/lib/resources/placement";
import {
  assertReservationDispatchable,
  releaseReservation,
  type AllocationRecord,
  type CapacityLedger,
  type CapacityReservation,
  type ReservationMutationResult
} from "@/lib/resources/reservations";
import type { ResourceReliabilityTier } from "@/lib/resources/policy";
import {
  assertCostGovernorReportIntegrity,
  assertGovernorAllowsAutonomousScheduling,
  type CostGovernorReport
} from "@/lib/resources/cost-governor";
import {
  assertCredentialLease,
  type CredentialLease
} from "@/lib/credentials/broker";
import {
  blockingKillSwitches,
  type KillSwitch
} from "@/lib/domain/kill-switch";
import type { ResourceState } from "@/lib/domain/resources";
import {
  assertPolicyRegistryReference,
  type PolicyRegistryReference
} from "@/lib/domain/policy-registry";
import { hashKillSwitchSnapshot } from "@/lib/planning/policy-snapshot";
import {
  assertVerificationTrustAttestation,
  type VerificationTrustAttestation
} from "@/lib/verification/source-trust";
import {
  assertVerificationReceipt,
  assertVerificationRequestIntegrity,
  createVerificationRequest,
  type VerificationReceipt,
  type VerificationRequest
} from "@/lib/verification/verification";

export interface SchedulerWeights {
  reliability: number;
  locality: number;
  cost: number;
  startupLatency: number;
  protectedCapacityImpact: number;
  ownerPreference: number;
}

export interface SchedulerPreferences {
  weights: SchedulerWeights;
  preferredLocality?: string;
  ownerPreferredResourceIds?: readonly string[];
}

export interface SchedulerCandidateSnapshot {
  resourceId: string;
  placementCandidateSnapshotHash: string;
  reliabilityTier: ResourceReliabilityTier;
  locality?: string;
  estimatedCostCents?: number;
  startupLatencyMs: number;
  protectedCapacityImpactPct: number;
  observedAt: string;
  expiresAt: string;
  snapshotHash: string;
}

export interface RankedSchedulerCandidate {
  resourceId: string;
  placementCandidateSnapshotHash: string;
  schedulerSnapshotHash: string;
  score: number;
  components: Readonly<{
    reliability: number;
    locality: number;
    cost: number;
    startupLatency: number;
    protectedCapacityImpact: number;
    ownerPreference: number;
  }>;
  explanation: readonly string[];
}

export interface SchedulerRankingReport {
  placementRequestId: string;
  placementReportHash: string;
  governorReportHash: string;
  evaluatedAt: string;
  rankedEligibleCandidates: readonly RankedSchedulerCandidate[];
  governorAdmittedCandidateIds: readonly string[];
  approvalRequiredCandidateIds: readonly string[];
  governorBlockedCandidateIds: readonly string[];
  ignoredIneligibleCandidateIds: readonly string[];
  reportHash: string;
}

export interface SchedulerPlacementDecision {
  id: string;
  source: "control-plane-scheduler";
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  jobId: string;
  placementRequestId: string;
  placementRequestHash: string;
  placementReportHash: string;
  governorReportHash: string;
  rankingReportHash: string;
  selectedResourceId: string;
  selectedTarget: Readonly<{ type: "resource"; id: string }>;
  selectedPlacementSnapshotHash: string;
  selectedSchedulerSnapshotHash: string;
  selectedScore: number;
  rationale: readonly string[];
  retryOfDecisionId?: string;
  retryOfDecisionHash?: string;
  retryReason?: string;
  decidedAt: string;
  decisionHash: string;
}

export interface DispatchIntent {
  id: string;
  source: "control-plane";
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  jobId: string;
  placementRequestId: string;
  placementDecisionId: string;
  placementDecisionHash: string;
  selectedResourceId: string;
  reservationId: string;
  reservationHash: string;
  allocationId: string;
  allocationHash: string;
  adapterId: string;
  adapterVersion: string;
  providerId: string;
  capability: string;
  credentialLeaseId: string;
  credentialLeaseHash: string;
  dispatchAdmissionReceiptId: string;
  dispatchAdmissionReceiptHash: string;
  idempotencyKey: string;
  issuedAt: string;
  expiresAt: string;
  dispatchHash: string;
}

export interface DispatchAdmissionReceipt {
  id: string;
  source: "control-plane";
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  jobId: string;
  placementRequestId: string;
  placementDecisionId: string;
  placementDecisionHash: string;
  placementReportHash: string;
  governorReportHash: string;
  resourceId: string;
  reservationId: string;
  reservationHash: string;
  allocationId: string;
  allocationHash: string;
  credentialLeaseId: string;
  credentialLeaseHash: string;
  providerId: string;
  capability: string;
  policyRegistryHash: string;
  policyVersion: string;
  killSwitchSnapshotHash: string;
  resourceState: ResourceState;
  admittedAt: string;
  expiresAt: string;
  receiptHash: string;
}

export interface DispatchAdapterResult {
  source: "resource-adapter";
  dispatchIntentId: string;
  dispatchHash: string;
  adapterId: string;
  adapterVersion: string;
  status: "accepted" | "rejected";
  providerOperationId?: string;
  executionRef?: string;
  observedAt: string;
  resultHash: string;
}

export interface ResourceDispatchAdapter {
  dispatch(intent: DispatchIntent): Promise<DispatchAdapterResult>;
}

export interface VerifiedRunningPlacement {
  id: string;
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  jobId: string;
  placementDecisionId: string;
  placementDecisionHash: string;
  reservationId: string;
  reservationHash: string;
  allocationId: string;
  allocationHash: string;
  dispatchIntentId: string;
  dispatchHash: string;
  providerOperationId?: string;
  startVerificationRequestId: string;
  startVerificationReceiptId: string;
  startVerificationReceiptHash: string;
  startVerificationTrustAttestationId: string;
  startVerificationTrustAttestationHash: string;
  startedVerifiedAt: string;
  state: "running-verified";
  jobStateMutationApplied: false;
  recordHash: string;
}

export interface PlacementMonitorRecord {
  id: string;
  runningPlacementId: string;
  runningPlacementHash: string;
  state: "monitoring";
  openedAt: string;
  expectedHeartbeatSeconds: number;
  monitorHash: string;
}

export interface VerifiedPlacementCompletion {
  id: string;
  runningPlacementId: string;
  runningPlacementHash: string;
  completionVerificationRequestId: string;
  completionVerificationReceiptId: string;
  completionVerificationReceiptHash: string;
  completionVerificationTrustAttestationId: string;
  completionVerificationTrustAttestationHash: string;
  verifiedAt: string;
  state: "completed-verified";
  jobStateMutationApplied: false;
  recordHash: string;
}

export interface SchedulerAuditEntry {
  id: string;
  eventType:
    | "placement.decision"
    | "placement.dispatch-requested"
    | "placement.dispatch-provider-result"
    | "placement.start-verified"
    | "placement.completion-verified"
    | "placement.capacity-released";
  portfolioId: string;
  companyId: string;
  jobId: string;
  occurredAt: string;
  explanation: readonly string[];
  relatedHashes: readonly string[];
  auditHash: string;
}

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function requireNonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be non-negative`);
  }
}

function assertPlacementReportIntegrity(report: PlacementEvaluationReport) {
  const { reportHash, ...base } = report;
  if (sha256Hex(base) !== reportHash) {
    throw new ControlPlaneError("FORBIDDEN", "Placement evaluation report integrity check failed");
  }
}

function assertSchedulerSnapshotIntegrity(snapshot: SchedulerCandidateSnapshot) {
  const { snapshotHash, ...base } = snapshot;
  if (sha256Hex(base) !== snapshotHash) {
    throw new ControlPlaneError("FORBIDDEN", "Scheduler candidate snapshot integrity check failed");
  }
}

function assertDecisionIntegrity(decision: SchedulerPlacementDecision) {
  const { decisionHash, ...base } = decision;
  if (sha256Hex(base) !== decisionHash) {
    throw new ControlPlaneError("FORBIDDEN", "Placement decision integrity check failed");
  }
}

function assertDispatchIntegrity(dispatch: DispatchIntent) {
  const { dispatchHash, ...base } = dispatch;
  if (sha256Hex(base) !== dispatchHash) {
    throw new ControlPlaneError("FORBIDDEN", "Dispatch intent integrity check failed");
  }
}

function assertAdapterResultIntegrity(result: DispatchAdapterResult) {
  const { resultHash, ...base } = result;
  if (sha256Hex(base) !== resultHash) {
    throw new ControlPlaneError("FORBIDDEN", "Dispatch adapter result integrity check failed");
  }
}

function reliabilityScore(tier: ResourceReliabilityTier) {
  const scores: Record<ResourceReliabilityTier, number> = {
    BEST_EFFORT: 0.25,
    STANDARD: 0.5,
    HIGH: 0.75,
    CRITICAL: 1
  };
  return scores[tier];
}

function normalizeWeights(weights: SchedulerWeights) {
  const entries = Object.entries(weights) as Array<[keyof SchedulerWeights, number]>;
  for (const [key, value] of entries) {
    requireNonNegative(value, `Scheduler weight ${key}`);
  }
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "At least one scheduler preference weight must be positive"
    );
  }
  return { entries, total };
}

export function createSchedulerCandidateSnapshot(
  input: Omit<SchedulerCandidateSnapshot, "snapshotHash">
): SchedulerCandidateSnapshot {
  requireNonNegative(input.startupLatencyMs, "Startup latency");
  requireNonNegative(input.protectedCapacityImpactPct, "Protected capacity impact");
  if (input.protectedCapacityImpactPct > 100) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Protected capacity impact cannot exceed 100 percent"
    );
  }
  if (input.estimatedCostCents !== undefined) {
    requireNonNegative(input.estimatedCostCents, "Estimated cost");
  }
  const observedAt = parseTime(input.observedAt, "Scheduler snapshot observedAt");
  const expiresAt = parseTime(input.expiresAt, "Scheduler snapshot expiresAt");
  if (expiresAt <= observedAt) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Scheduler snapshot expiry must follow observation"
    );
  }
  const base: Omit<SchedulerCandidateSnapshot, "snapshotHash"> = {
    ...input
  };
  return Object.freeze({ ...base, snapshotHash: sha256Hex(base) });
}

export function rankEligibleCandidates(input: {
  placementReport: PlacementEvaluationReport;
  governorReport: CostGovernorReport;
  candidates: readonly SchedulerCandidateSnapshot[];
  preferences: SchedulerPreferences;
  evaluatedAt: string;
}): SchedulerRankingReport {
  assertPlacementReportIntegrity(input.placementReport);
  assertCostGovernorReportIntegrity(input.governorReport);
  if (input.governorReport.placementRequestId !== input.placementReport.placementRequestId) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Scheduler governor report does not match the placement evaluation"
    );
  }
  const evaluatedAt = parseTime(input.evaluatedAt, "Scheduler ranking evaluatedAt");
  const { entries: weightEntries, total: weightTotal } = normalizeWeights(
    input.preferences.weights
  );
  const byResource = new Map(input.candidates.map((candidate) => {
    assertSchedulerSnapshotIntegrity(candidate);
    return [candidate.resourceId, candidate] as const;
  }));
  const placementByResource = new Map(
    input.placementReport.candidates.map((candidate) => [candidate.resourceId, candidate])
  );

  const placementEligibleIds = new Set(input.placementReport.eligibleCandidateIds);
  const eligibleIds = input.governorReport.rankedAllowedCandidateIds
    .filter((resourceId) => placementEligibleIds.has(resourceId))
    .sort();
  if (eligibleIds.length === 0) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "No placement-eligible candidates are autonomously allowed by the cost/capacity governor"
    );
  }

  const eligibleSnapshots = eligibleIds.map((resourceId) => {
    const scheduler = byResource.get(resourceId);
    const placement = placementByResource.get(resourceId);
    if (!scheduler || !placement || !placement.eligible) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Scheduler input is missing authoritative eligibility lineage"
      );
    }
    if (scheduler.placementCandidateSnapshotHash !== placement.snapshotHash) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Scheduler snapshot does not match the eligible placement candidate snapshot"
      );
    }
    if (
      Date.parse(scheduler.observedAt) > evaluatedAt
      || Date.parse(scheduler.expiresAt) <= evaluatedAt
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Scheduler candidate snapshot is stale or from the future"
      );
    }
    return scheduler;
  });

  const maxCost = Math.max(
    1,
    ...eligibleSnapshots.map((candidate) => candidate.estimatedCostCents ?? 0)
  );
  const maxStartup = Math.max(
    1,
    ...eligibleSnapshots.map((candidate) => candidate.startupLatencyMs)
  );
  const ownerPreferred = input.preferences.ownerPreferredResourceIds ?? [];

  const ranked = eligibleSnapshots.map((candidate): RankedSchedulerCandidate => {
    const ownerIndex = ownerPreferred.indexOf(candidate.resourceId);
    const ownerPreference = ownerIndex < 0
      ? 0
      : ownerPreferred.length === 1
        ? 1
        : 1 - ownerIndex / (ownerPreferred.length - 1);

    const components = Object.freeze({
      reliability: reliabilityScore(candidate.reliabilityTier),
      locality: input.preferences.preferredLocality
        ? candidate.locality === input.preferences.preferredLocality ? 1 : 0
        : 0.5,
      cost: candidate.estimatedCostCents === undefined
        ? 0
        : clamp(1 - candidate.estimatedCostCents / maxCost),
      startupLatency: clamp(1 - candidate.startupLatencyMs / maxStartup),
      protectedCapacityImpact: clamp(1 - candidate.protectedCapacityImpactPct / 100),
      ownerPreference
    });

    const weighted = weightEntries.reduce(
      (sum, [key, weight]) => sum + components[key] * weight,
      0
    ) / weightTotal;
    const score = Number(weighted.toFixed(6));
    const explanation = Object.freeze([
      "ranked:placement-hard-eligibility-preserved",
      `ranked:reliability=${components.reliability.toFixed(3)}`,
      `ranked:locality=${components.locality.toFixed(3)}`,
      `ranked:cost=${components.cost.toFixed(3)}`,
      `ranked:startup=${components.startupLatency.toFixed(3)}`,
      `ranked:protected-capacity=${components.protectedCapacityImpact.toFixed(3)}`,
      `ranked:owner-preference=${components.ownerPreference.toFixed(3)}`
    ]);

    return Object.freeze({
      resourceId: candidate.resourceId,
      placementCandidateSnapshotHash: candidate.placementCandidateSnapshotHash,
      schedulerSnapshotHash: candidate.snapshotHash,
      score,
      components,
      explanation
    });
  }).sort((left, right) =>
    right.score - left.score || left.resourceId.localeCompare(right.resourceId)
  );

  const ignoredIneligibleCandidateIds = input.placementReport.candidates
    .filter((candidate) => !candidate.eligible)
    .map((candidate) => candidate.resourceId)
    .sort();

  const base: Omit<SchedulerRankingReport, "reportHash"> = {
    placementRequestId: input.placementReport.placementRequestId,
    placementReportHash: input.placementReport.reportHash,
    governorReportHash: input.governorReport.reportHash,
    evaluatedAt: new Date(evaluatedAt).toISOString(),
    rankedEligibleCandidates: Object.freeze(ranked),
    governorAdmittedCandidateIds: Object.freeze([...eligibleIds]),
    approvalRequiredCandidateIds: Object.freeze([...input.governorReport.approvalRequiredCandidateIds]),
    governorBlockedCandidateIds: Object.freeze([...input.governorReport.blockedCandidateIds]),
    ignoredIneligibleCandidateIds: Object.freeze(ignoredIneligibleCandidateIds)
  };
  return Object.freeze({ ...base, reportHash: sha256Hex(base) });
}

export function createPlacementDecision(input: {
  id: string;
  request: PlacementRequestRecord;
  placementReport: PlacementEvaluationReport;
  rankingReport: SchedulerRankingReport;
  selectedResourceId?: string;
  decidedAt: string;
  retryOf?: SchedulerPlacementDecision;
  retryReason?: string;
}): SchedulerPlacementDecision {
  assertPlacementReportIntegrity(input.placementReport);
  const rankingBase = {
    placementRequestId: input.rankingReport.placementRequestId,
    placementReportHash: input.rankingReport.placementReportHash,
    governorReportHash: input.rankingReport.governorReportHash,
    evaluatedAt: input.rankingReport.evaluatedAt,
    rankedEligibleCandidates: input.rankingReport.rankedEligibleCandidates,
    governorAdmittedCandidateIds: input.rankingReport.governorAdmittedCandidateIds,
    approvalRequiredCandidateIds: input.rankingReport.approvalRequiredCandidateIds,
    governorBlockedCandidateIds: input.rankingReport.governorBlockedCandidateIds,
    ignoredIneligibleCandidateIds: input.rankingReport.ignoredIneligibleCandidateIds
  };
  if (sha256Hex(rankingBase) !== input.rankingReport.reportHash) {
    throw new ControlPlaneError("FORBIDDEN", "Scheduler ranking report integrity check failed");
  }
  const { requestHash, ...requestBase } = input.request;
  if (sha256Hex(requestBase) !== requestHash) {
    throw new ControlPlaneError("FORBIDDEN", "Placement request integrity check failed");
  }
  if (
    input.request.id !== input.placementReport.placementRequestId
    || input.request.id !== input.rankingReport.placementRequestId
    || input.placementReport.reportHash !== input.rankingReport.placementReportHash
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Placement decision lineage is inconsistent");
  }

  const selectedResourceId = input.selectedResourceId
    ?? input.rankingReport.rankedEligibleCandidates[0]?.resourceId;
  const selected = input.rankingReport.rankedEligibleCandidates.find(
    (candidate) => candidate.resourceId === selectedResourceId
  );
  if (!selected) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Scheduler may select only a ranked placement-eligible candidate"
    );
  }

  if (input.retryOf) {
    assertDecisionIntegrity(input.retryOf);
    if (!input.retryReason || input.retryOf.jobId !== input.request.jobId) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Retry/fallback requires prior decision lineage and an explicit reason"
      );
    }
    if (input.retryOf.id === input.id) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Retry/fallback must create a new placement decision"
      );
    }
  } else if (input.retryReason) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Retry reason requires a prior placement decision"
    );
  }

  const decidedAt = new Date(parseTime(input.decidedAt, "Placement decision decidedAt")).toISOString();
  const base: Omit<SchedulerPlacementDecision, "decisionHash"> = {
    id: input.id,
    source: "control-plane-scheduler",
    portfolioId: input.request.portfolioId,
    companyId: input.request.companyId,
    environment: input.request.environment,
    jobId: input.request.jobId,
    placementRequestId: input.request.id,
    placementRequestHash: input.request.requestHash,
    placementReportHash: input.placementReport.reportHash,
    governorReportHash: input.rankingReport.governorReportHash,
    rankingReportHash: input.rankingReport.reportHash,
    selectedResourceId,
    selectedTarget: Object.freeze({ type: "resource" as const, id: selectedResourceId }),
    selectedPlacementSnapshotHash: selected.placementCandidateSnapshotHash,
    selectedSchedulerSnapshotHash: selected.schedulerSnapshotHash,
    selectedScore: selected.score,
    rationale: Object.freeze([
      ...selected.explanation,
      `selected:score=${selected.score.toFixed(6)}`,
      ...(input.retryReason ? [`retry:${input.retryReason}`] : [])
    ]),
    retryOfDecisionId: input.retryOf?.id,
    retryOfDecisionHash: input.retryOf?.decisionHash,
    retryReason: input.retryReason,
    decidedAt
  };
  return Object.freeze({ ...base, decisionHash: sha256Hex(base) });
}

export function reservationAuthorityFromDecision(
  decision: SchedulerPlacementDecision
) {
  assertDecisionIntegrity(decision);
  return Object.freeze({
    source: "control-plane" as const,
    jobAuthorized: true as const,
    portfolioId: decision.portfolioId,
    companyId: decision.companyId,
    jobId: decision.jobId,
    placementRequestId: decision.placementRequestId,
    placementDecisionId: decision.id,
    placementDecisionHash: decision.decisionHash,
    selectedTarget: decision.selectedTarget
  });
}

export function assertDispatchAdmissionReceipt(
  receipt: DispatchAdmissionReceipt,
  input: {
    decision: SchedulerPlacementDecision;
    reservation: CapacityReservation;
    allocation: AllocationRecord;
    credentialLease: CredentialLease;
    now?: number;
  }
) {
  const { receiptHash, ...base } = receipt;
  if (sha256Hex(base) !== receiptHash) {
    throw new ControlPlaneError("FORBIDDEN", "Dispatch admission receipt integrity check failed");
  }
  const now = input.now ?? Date.now();
  if (
    receipt.source !== "control-plane"
    || Date.parse(receipt.admittedAt) > now
    || Date.parse(receipt.expiresAt) <= now
    || receipt.portfolioId !== input.decision.portfolioId
    || receipt.companyId !== input.decision.companyId
    || receipt.environment !== input.decision.environment
    || receipt.jobId !== input.decision.jobId
    || receipt.placementRequestId !== input.decision.placementRequestId
    || receipt.placementDecisionId !== input.decision.id
    || receipt.placementDecisionHash !== input.decision.decisionHash
    || receipt.placementReportHash !== input.decision.placementReportHash
    || receipt.governorReportHash !== input.decision.governorReportHash
    || receipt.resourceId !== input.decision.selectedResourceId
    || receipt.reservationId !== input.reservation.id
    || receipt.reservationHash !== input.reservation.reservationHash
    || receipt.allocationId !== input.allocation.id
    || receipt.allocationHash !== input.allocation.allocationHash
    || receipt.credentialLeaseId !== input.credentialLease.id
    || receipt.credentialLeaseHash !== input.credentialLease.leaseHash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Dispatch admission receipt is stale or outside authoritative dispatch lineage"
    );
  }
  return receipt;
}

export function createDispatchAdmissionReceipt(input: {
  id: string;
  decision: SchedulerPlacementDecision;
  reservation: CapacityReservation;
  allocation: AllocationRecord;
  credentialLease: CredentialLease;
  governorReport: CostGovernorReport;
  policyRegistry: PolicyRegistryReference;
  killSwitches: readonly KillSwitch[];
  resourceState: ResourceState;
  environmentPermissions: readonly TrustedExecutionScope["environment"][];
  providerId: string;
  capability: string;
  admittedAt: string;
  ttlSeconds?: number;
}): DispatchAdmissionReceipt {
  assertDecisionIntegrity(input.decision);
  assertCostGovernorReportIntegrity(input.governorReport);
  assertPolicyRegistryReference(input.policyRegistry);

  const admittedAt = parseTime(input.admittedAt, "Dispatch admission time");
  assertReservationDispatchable(input.reservation, admittedAt);

  if (
    input.resourceState !== "ready"
    || !input.environmentPermissions.includes(input.decision.environment)
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Dispatch admission requires a READY resource authorized for the target environment"
    );
  }

  if (
    input.reservation.portfolioId !== input.decision.portfolioId
    || input.reservation.companyId !== input.decision.companyId
    || input.reservation.jobId !== input.decision.jobId
    || input.reservation.placementRequestId !== input.decision.placementRequestId
    || input.reservation.placementDecisionId !== input.decision.id
    || input.reservation.placementDecisionHash !== input.decision.decisionHash
    || input.reservation.target.type !== "resource"
    || input.reservation.target.id !== input.decision.selectedResourceId
    || input.allocation.reservationId !== input.reservation.id
    || input.allocation.reservationHash !== input.reservation.reservationHash
    || input.allocation.status !== "pending"
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Dispatch admission reservation/allocation lineage is invalid"
    );
  }

  assertGovernorAllowsAutonomousScheduling(input.governorReport, {
    placementRequestId: input.decision.placementRequestId,
    portfolioId: input.decision.portfolioId,
    companyId: input.decision.companyId,
    resourceId: input.decision.selectedResourceId,
    now: admittedAt
  });
  if (input.governorReport.reportHash !== input.decision.governorReportHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Dispatch admission governor report does not match the placement decision"
    );
  }

  const scope: TrustedExecutionScope = {
    userId: "dispatch-admission",
    portfolioId: input.decision.portfolioId,
    companyId: input.decision.companyId,
    environment: input.decision.environment,
    resourceId: input.decision.selectedResourceId
  };
  assertCredentialLease(input.credentialLease, {
    scope,
    jobId: input.decision.jobId,
    resourceId: input.decision.selectedResourceId,
    capability: input.capability,
    now: admittedAt
  });
  if (
    input.credentialLease.placementRequestId !== input.decision.placementRequestId
    || input.credentialLease.providerId !== input.providerId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Credential lease does not match placement/provider dispatch lineage"
    );
  }

  const blockers = blockingKillSwitches(input.killSwitches, {
    portfolioId: input.decision.portfolioId,
    companyId: input.decision.companyId,
    capability: input.capability,
    resourceId: input.decision.selectedResourceId,
    providerId: input.providerId
  });
  if (blockers.length > 0) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Current kill switches block dispatch admission",
      { details: { killSwitchIds: blockers.map((item) => item.id).sort() } }
    );
  }

  const ttlSeconds = input.ttlSeconds ?? 60;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 300) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Dispatch admission TTL must be 1-300 seconds"
    );
  }
  const expiresAtMs = Math.min(
    admittedAt + ttlSeconds * 1000,
    Date.parse(input.reservation.expiresAt),
    Date.parse(input.credentialLease.expiresAt),
    Date.parse(input.governorReport.expiresAt)
  );
  if (expiresAtMs <= admittedAt) {
    throw new ControlPlaneError("FORBIDDEN", "Dispatch admission inputs expire too soon");
  }

  const base: Omit<DispatchAdmissionReceipt, "receiptHash"> = {
    id: input.id,
    source: "control-plane",
    portfolioId: input.decision.portfolioId,
    companyId: input.decision.companyId,
    environment: input.decision.environment,
    jobId: input.decision.jobId,
    placementRequestId: input.decision.placementRequestId,
    placementDecisionId: input.decision.id,
    placementDecisionHash: input.decision.decisionHash,
    placementReportHash: input.decision.placementReportHash,
    governorReportHash: input.governorReport.reportHash,
    resourceId: input.decision.selectedResourceId,
    reservationId: input.reservation.id,
    reservationHash: input.reservation.reservationHash,
    allocationId: input.allocation.id,
    allocationHash: input.allocation.allocationHash,
    credentialLeaseId: input.credentialLease.id,
    credentialLeaseHash: input.credentialLease.leaseHash,
    providerId: input.providerId,
    capability: input.capability,
    policyRegistryHash: input.policyRegistry.registryHash,
    policyVersion: input.policyRegistry.version,
    killSwitchSnapshotHash: hashKillSwitchSnapshot(input.killSwitches),
    resourceState: input.resourceState,
    admittedAt: new Date(admittedAt).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString()
  };
  return Object.freeze({ ...base, receiptHash: sha256Hex(base) });
}

export function createDispatchIntent(input: {
  id: string;
  decision: SchedulerPlacementDecision;
  reservation: CapacityReservation;
  allocation: AllocationRecord;
  credentialLease: CredentialLease;
  admissionReceipt: DispatchAdmissionReceipt;
  adapterId: string;
  adapterVersion: string;
  providerId: string;
  capability: string;
  idempotencyKey: string;
  issuedAt: string;
  now?: number;
}): DispatchIntent {
  assertDecisionIntegrity(input.decision);
  const now = input.now ?? Date.now();
  assertReservationDispatchable(input.reservation, now);
  assertCredentialLease(input.credentialLease, {
    scope: {
      userId: "dispatch",
      portfolioId: input.decision.portfolioId,
      companyId: input.decision.companyId,
      environment: input.decision.environment,
      resourceId: input.decision.selectedResourceId
    },
    jobId: input.decision.jobId,
    resourceId: input.decision.selectedResourceId,
    capability: input.capability,
    now
  });
  assertDispatchAdmissionReceipt(input.admissionReceipt, {
    decision: input.decision,
    reservation: input.reservation,
    allocation: input.allocation,
    credentialLease: input.credentialLease,
    now
  });

  if (
    input.reservation.portfolioId !== input.decision.portfolioId
    || input.reservation.companyId !== input.decision.companyId
    || input.reservation.jobId !== input.decision.jobId
    || input.reservation.placementRequestId !== input.decision.placementRequestId
    || input.reservation.placementDecisionId !== input.decision.id
    || input.reservation.placementDecisionHash !== input.decision.decisionHash
    || input.reservation.target.type !== "resource"
    || input.reservation.target.id !== input.decision.selectedResourceId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Dispatch reservation does not match the authoritative placement decision"
    );
  }
  if (
    input.allocation.portfolioId !== input.reservation.portfolioId
    || input.allocation.companyId !== input.reservation.companyId
    || input.allocation.jobId !== input.reservation.jobId
    || input.allocation.reservationId !== input.reservation.id
    || input.allocation.reservationHash !== input.reservation.reservationHash
    || input.allocation.status !== "pending"
    || input.allocation.target.type !== input.reservation.target.type
    || input.allocation.target.id !== input.reservation.target.id
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Dispatch allocation does not match the live reservation"
    );
  }
  if (!input.id || !input.adapterId || !input.adapterVersion || !input.idempotencyKey) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Dispatch identity, adapter binding, and idempotency key are required"
    );
  }
  const issuedAtMs = parseTime(input.issuedAt, "Dispatch issuedAt");
  if (
    issuedAtMs > now
    || issuedAtMs >= Date.parse(input.reservation.expiresAt)
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Dispatch cannot be issued in the future or after reservation expiry"
    );
  }

  const base: Omit<DispatchIntent, "dispatchHash"> = {
    id: input.id,
    source: "control-plane",
    portfolioId: input.decision.portfolioId,
    companyId: input.decision.companyId,
    environment: input.decision.environment,
    jobId: input.decision.jobId,
    placementRequestId: input.decision.placementRequestId,
    placementDecisionId: input.decision.id,
    placementDecisionHash: input.decision.decisionHash,
    selectedResourceId: input.decision.selectedResourceId,
    reservationId: input.reservation.id,
    reservationHash: input.reservation.reservationHash,
    allocationId: input.allocation.id,
    allocationHash: input.allocation.allocationHash,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    providerId: input.providerId,
    capability: input.capability,
    credentialLeaseId: input.credentialLease.id,
    credentialLeaseHash: input.credentialLease.leaseHash,
    dispatchAdmissionReceiptId: input.admissionReceipt.id,
    dispatchAdmissionReceiptHash: input.admissionReceipt.receiptHash,
    idempotencyKey: input.idempotencyKey,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: input.reservation.expiresAt
  };
  return Object.freeze({ ...base, dispatchHash: sha256Hex(base) });
}

export function createDispatchAdapterResult(input: Omit<DispatchAdapterResult, "resultHash">) {
  if (input.source !== "resource-adapter") {
    throw new ControlPlaneError("FORBIDDEN", "Dispatch result must come from a resource adapter");
  }
  if (!input.dispatchIntentId || !input.dispatchHash || !input.adapterId || !input.adapterVersion) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Dispatch adapter result lineage is required");
  }
  parseTime(input.observedAt, "Dispatch adapter observedAt");
  if (input.status === "accepted" && !input.providerOperationId) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Accepted dispatch requires a provider operation identifier"
    );
  }
  const base: Omit<DispatchAdapterResult, "resultHash"> = { ...input };
  return Object.freeze({ ...base, resultHash: sha256Hex(base) });
}

export function createStartVerificationRequest(input: {
  id: string;
  dispatch: DispatchIntent;
  requestedAt: string;
  expiresAt: string;
  maxEvidenceAgeSeconds: number;
}): VerificationRequest {
  assertDispatchIntegrity(input.dispatch);
  return createVerificationRequest({
    id: input.id,
    portfolioId: input.dispatch.portfolioId,
    companyId: input.dispatch.companyId,
    environment: input.dispatch.environment,
    subject: { type: "allocation", id: input.dispatch.allocationId },
    strategies: ["resource-start"],
    requiresIndependentEvidence: true,
    executionIndependenceKey: input.dispatch.dispatchHash,
    maxEvidenceAgeSeconds: input.maxEvidenceAgeSeconds,
    requestedAt: input.requestedAt,
    expiresAt: input.expiresAt
  });
}

function assertStartVerificationLineage(input: {
  dispatch: DispatchIntent;
  adapterResult: DispatchAdapterResult;
  request: VerificationRequest;
  receipt: VerificationReceipt;
  scope: TrustedExecutionScope;
  now: number;
}) {
  assertDispatchIntegrity(input.dispatch);
  assertAdapterResultIntegrity(input.adapterResult);
  assertVerificationRequestIntegrity(input.request);

  if (
    input.adapterResult.dispatchIntentId !== input.dispatch.id
    || input.adapterResult.dispatchHash !== input.dispatch.dispatchHash
    || input.adapterResult.adapterId !== input.dispatch.adapterId
    || input.adapterResult.adapterVersion !== input.dispatch.adapterVersion
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Provider dispatch result lineage is invalid");
  }
  if (input.adapterResult.status !== "accepted") {
    throw new ControlPlaneError("FORBIDDEN", "Rejected provider dispatch cannot verify a start");
  }

  if (
    input.request.subject.type !== "allocation"
    || input.request.subject.id !== input.dispatch.allocationId
    || !input.request.strategies.includes("resource-start")
    || !input.request.requiresIndependentEvidence
    || input.request.executionIndependenceKey !== input.dispatch.dispatchHash
    || input.receipt.requestId !== input.request.id
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Start verification request is not independently bound to this dispatch"
    );
  }

  assertVerificationReceipt(input.receipt, {
    scope: input.scope,
    subject: input.request.subject,
    now: input.now,
    allowedVerdicts: ["verified"]
  });

  if (!input.receipt.strategyResults.some(
    (result) => result.strategy === "resource-start" && result.verdict === "verified"
  )) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Provider acceptance is insufficient; independent resource-start verification is required"
    );
  }
}

export function createVerifiedRunningPlacement(input: {
  id: string;
  decision: SchedulerPlacementDecision;
  reservation: CapacityReservation;
  allocation: AllocationRecord;
  dispatch: DispatchIntent;
  adapterResult: DispatchAdapterResult;
  verificationRequest: VerificationRequest;
  verificationReceipt: VerificationReceipt;
  verificationTrustAttestation: VerificationTrustAttestation;
  scope: TrustedExecutionScope;
  now?: number;
}): VerifiedRunningPlacement {
  const now = input.now ?? Date.now();
  assertDecisionIntegrity(input.decision);
  assertReservationDispatchable(input.reservation, now);

  if (
    input.dispatch.placementDecisionHash !== input.decision.decisionHash
    || input.dispatch.reservationHash !== input.reservation.reservationHash
    || input.dispatch.allocationHash !== input.allocation.allocationHash
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Running placement lineage is inconsistent");
  }

  assertStartVerificationLineage({
    dispatch: input.dispatch,
    adapterResult: input.adapterResult,
    request: input.verificationRequest,
    receipt: input.verificationReceipt,
    scope: input.scope,
    now
  });
  assertVerificationTrustAttestation(input.verificationTrustAttestation, {
    request: input.verificationRequest,
    receipt: input.verificationReceipt,
    scope: input.scope,
    now
  });

  const base: Omit<VerifiedRunningPlacement, "recordHash"> = {
    id: input.id,
    portfolioId: input.decision.portfolioId,
    companyId: input.decision.companyId,
    environment: input.decision.environment,
    jobId: input.decision.jobId,
    placementDecisionId: input.decision.id,
    placementDecisionHash: input.decision.decisionHash,
    reservationId: input.reservation.id,
    reservationHash: input.reservation.reservationHash,
    allocationId: input.allocation.id,
    allocationHash: input.allocation.allocationHash,
    dispatchIntentId: input.dispatch.id,
    dispatchHash: input.dispatch.dispatchHash,
    providerOperationId: input.adapterResult.providerOperationId,
    startVerificationRequestId: input.verificationRequest.id,
    startVerificationReceiptId: input.verificationReceipt.id,
    startVerificationReceiptHash: input.verificationReceipt.receiptHash,
    startVerificationTrustAttestationId: input.verificationTrustAttestation.id,
    startVerificationTrustAttestationHash: input.verificationTrustAttestation.attestationHash,
    startedVerifiedAt: input.verificationReceipt.verifiedAt,
    state: "running-verified",
    jobStateMutationApplied: false
  };
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}

export function createPlacementMonitor(input: {
  id: string;
  runningPlacement: VerifiedRunningPlacement;
  openedAt: string;
  expectedHeartbeatSeconds: number;
}): PlacementMonitorRecord {
  requireNonNegative(input.expectedHeartbeatSeconds, "Expected heartbeat seconds");
  if (input.expectedHeartbeatSeconds <= 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Expected heartbeat must be positive");
  }
  const { recordHash, ...runningBase } = input.runningPlacement;
  if (sha256Hex(runningBase) !== recordHash) {
    throw new ControlPlaneError("FORBIDDEN", "Running placement integrity check failed");
  }
  const base: Omit<PlacementMonitorRecord, "monitorHash"> = {
    id: input.id,
    runningPlacementId: input.runningPlacement.id,
    runningPlacementHash: input.runningPlacement.recordHash,
    state: "monitoring",
    openedAt: new Date(parseTime(input.openedAt, "Monitor openedAt")).toISOString(),
    expectedHeartbeatSeconds: input.expectedHeartbeatSeconds
  };
  return Object.freeze({ ...base, monitorHash: sha256Hex(base) });
}

export function createCompletionVerificationRequest(input: {
  id: string;
  runningPlacement: VerifiedRunningPlacement;
  requestedAt: string;
  expiresAt: string;
  maxEvidenceAgeSeconds: number;
}): VerificationRequest {
  const { recordHash, ...runningBase } = input.runningPlacement;
  if (sha256Hex(runningBase) !== recordHash) {
    throw new ControlPlaneError("FORBIDDEN", "Running placement integrity check failed");
  }
  return createVerificationRequest({
    id: input.id,
    portfolioId: input.runningPlacement.portfolioId,
    companyId: input.runningPlacement.companyId,
    environment: input.runningPlacement.environment,
    subject: { type: "allocation", id: input.runningPlacement.allocationId },
    strategies: ["execution"],
    requiresIndependentEvidence: true,
    executionIndependenceKey: input.runningPlacement.dispatchHash,
    maxEvidenceAgeSeconds: input.maxEvidenceAgeSeconds,
    requestedAt: input.requestedAt,
    expiresAt: input.expiresAt
  });
}

export function createVerifiedPlacementCompletion(input: {
  id: string;
  runningPlacement: VerifiedRunningPlacement;
  verificationRequest: VerificationRequest;
  verificationReceipt: VerificationReceipt;
  verificationTrustAttestation: VerificationTrustAttestation;
  scope: TrustedExecutionScope;
  now?: number;
}): VerifiedPlacementCompletion {
  const now = input.now ?? Date.now();
  const { recordHash, ...runningBase } = input.runningPlacement;
  if (sha256Hex(runningBase) !== recordHash) {
    throw new ControlPlaneError("FORBIDDEN", "Running placement integrity check failed");
  }
  assertVerificationRequestIntegrity(input.verificationRequest);
  if (
    input.verificationRequest.subject.type !== "allocation"
    || input.verificationRequest.subject.id !== input.runningPlacement.allocationId
    || !input.verificationRequest.strategies.includes("execution")
    || !input.verificationRequest.requiresIndependentEvidence
    || input.verificationRequest.executionIndependenceKey !== input.runningPlacement.dispatchHash
    || input.verificationReceipt.requestId !== input.verificationRequest.id
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Completion verification lineage is invalid");
  }
  assertVerificationReceipt(input.verificationReceipt, {
    scope: input.scope,
    subject: input.verificationRequest.subject,
    now,
    allowedVerdicts: ["verified"]
  });
  if (!input.verificationReceipt.strategyResults.some(
    (result) => result.strategy === "execution" && result.verdict === "verified"
  )) {
    throw new ControlPlaneError("FORBIDDEN", "Completion requires verified execution evidence");
  }
  assertVerificationTrustAttestation(input.verificationTrustAttestation, {
    request: input.verificationRequest,
    receipt: input.verificationReceipt,
    scope: input.scope,
    now
  });

  const base: Omit<VerifiedPlacementCompletion, "recordHash"> = {
    id: input.id,
    runningPlacementId: input.runningPlacement.id,
    runningPlacementHash: input.runningPlacement.recordHash,
    completionVerificationRequestId: input.verificationRequest.id,
    completionVerificationReceiptId: input.verificationReceipt.id,
    completionVerificationReceiptHash: input.verificationReceipt.receiptHash,
    completionVerificationTrustAttestationId: input.verificationTrustAttestation.id,
    completionVerificationTrustAttestationHash: input.verificationTrustAttestation.attestationHash,
    verifiedAt: input.verificationReceipt.verifiedAt,
    state: "completed-verified",
    jobStateMutationApplied: false
  };
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}

export function releaseVerifiedPlacement(input: {
  transactionId: string;
  ledger: CapacityLedger;
  expectedLedgerRevision: number;
  reservation: CapacityReservation;
  completion: VerifiedPlacementCompletion;
  runningPlacement: VerifiedRunningPlacement;
  releasedAt: string;
}): ReservationMutationResult {
  const { recordHash: completionHash, ...completionBase } = input.completion;
  const { recordHash: runningHash, ...runningBase } = input.runningPlacement;
  if (
    sha256Hex(completionBase) !== completionHash
    || sha256Hex(runningBase) !== runningHash
    || input.completion.runningPlacementId !== input.runningPlacement.id
    || input.completion.runningPlacementHash !== input.runningPlacement.recordHash
    || input.runningPlacement.reservationId !== input.reservation.id
    || input.runningPlacement.reservationHash !== input.reservation.reservationHash
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Verified completion does not match reservation lineage");
  }

  return releaseReservation({
    transactionId: input.transactionId,
    ledger: input.ledger,
    expectedLedgerRevision: input.expectedLedgerRevision,
    reservation: input.reservation,
    releasedAt: input.releasedAt
  });
}

export function createSchedulerAuditEntry(input: Omit<SchedulerAuditEntry, "auditHash">) {
  if (input.explanation.length === 0 || input.relatedHashes.length === 0) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Scheduler audit entries require explanation and hash lineage"
    );
  }
  parseTime(input.occurredAt, "Scheduler audit occurredAt");
  const base: Omit<SchedulerAuditEntry, "auditHash"> = {
    ...input,
    explanation: Object.freeze([...input.explanation]),
    relatedHashes: Object.freeze([...input.relatedHashes].sort())
  };
  return Object.freeze({ ...base, auditHash: sha256Hex(base) });
}
