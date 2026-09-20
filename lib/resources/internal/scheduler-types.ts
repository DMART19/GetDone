import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { ResourceReliabilityTier } from "@/lib/resources/policy";
import type { ResourceState } from "@/lib/domain/resources";

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

