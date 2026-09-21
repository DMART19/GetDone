import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type {
  VerifiedPlacementCompletion,
  VerifiedRunningPlacement
} from "@/lib/resources/scheduler";
import {
  assertVerificationRequestIntegrity,
  createVerificationEvidence,
  createVerificationRequest,
  type VerificationEvidence,
  type VerificationRequest
} from "@/lib/verification/verification";

export const JOB_EXECUTION_BRIDGE_CONTRACT_VERSION = "1.0.0";

export interface JobVerifiedStartFact {
  id: string;
  source: "phase34-verified-start";
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  jobId: string;
  runningPlacementId: string;
  runningPlacementHash: string;
  placementDecisionId: string;
  placementDecisionHash: string;
  reservationId: string;
  reservationHash: string;
  allocationId: string;
  allocationHash: string;
  startVerificationReceiptId: string;
  startVerificationReceiptHash: string;
  startVerificationTrustAttestationId: string;
  startVerificationTrustAttestationHash: string;
  verifiedAt: string;
  issuedAt: string;
  expiresAt: string;
  factHash: string;
}

export interface JobVerifiedCompletionFact {
  id: string;
  source: "phase34-verified-completion";
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  jobId: string;
  runningPlacementId: string;
  runningPlacementHash: string;
  completionId: string;
  completionHash: string;
  completionVerificationReceiptId: string;
  completionVerificationReceiptHash: string;
  completionVerificationTrustAttestationId: string;
  completionVerificationTrustAttestationHash: string;
  verifiedAt: string;
  bridgedAt: string;
  factHash: string;
}

export interface JobExecutionBridgeStore {
  getStartFact(id: string): Promise<JobVerifiedStartFact | null>;
  getCompletionFact(id: string): Promise<JobVerifiedCompletionFact | null>;
}

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

function assertScope(
  portfolioId: string,
  companyId: string,
  environment: TrustedExecutionScope["environment"],
  scope: TrustedExecutionScope
) {
  if (
    portfolioId !== scope.portfolioId
    || companyId !== scope.companyId
    || environment !== scope.environment
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Verified execution fact is outside trusted Job scope");
  }
}

function assertRunningPlacementIntegrity(running: VerifiedRunningPlacement) {
  const { recordHash, ...base } = running;
  if (
    sha256Hex(base) !== recordHash
    || running.state !== "running-verified"
    || running.jobStateMutationApplied !== false
    || !running.startVerificationReceiptHash
    || !running.startVerificationTrustAttestationHash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Job start requires an intact Phase 34 verified-running placement"
    );
  }
}

function assertCompletionIntegrity(
  completion: VerifiedPlacementCompletion,
  running: VerifiedRunningPlacement
) {
  const { recordHash, ...base } = completion;
  if (
    sha256Hex(base) !== recordHash
    || completion.state !== "completed-verified"
    || completion.jobStateMutationApplied !== false
    || completion.runningPlacementId !== running.id
    || completion.runningPlacementHash !== running.recordHash
    || !completion.completionVerificationReceiptHash
    || !completion.completionVerificationTrustAttestationHash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Job completion bridge requires intact Phase 34 verified completion lineage"
    );
  }
}

export function createJobVerifiedStartFact(input: {
  id: string;
  runningPlacement: VerifiedRunningPlacement;
  scope: TrustedExecutionScope;
  issuedAt: string;
  expiresAt: string;
}): JobVerifiedStartFact {
  assertRunningPlacementIntegrity(input.runningPlacement);
  assertScope(
    input.runningPlacement.portfolioId,
    input.runningPlacement.companyId,
    input.runningPlacement.environment,
    input.scope
  );

  const issuedAt = parseTime(input.issuedAt, "Job verified-start fact issuedAt");
  const expiresAt = parseTime(input.expiresAt, "Job verified-start fact expiresAt");
  const verifiedAt = parseTime(
    input.runningPlacement.startedVerifiedAt,
    "Job verified-start fact verifiedAt"
  );
  if (verifiedAt > issuedAt || expiresAt <= issuedAt) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verified-start fact must be issued after verification and expire later"
    );
  }

  const base: Omit<JobVerifiedStartFact, "factHash"> = {
    id: input.id,
    source: "phase34-verified-start",
    portfolioId: input.runningPlacement.portfolioId,
    companyId: input.runningPlacement.companyId,
    environment: input.runningPlacement.environment,
    jobId: input.runningPlacement.jobId,
    runningPlacementId: input.runningPlacement.id,
    runningPlacementHash: input.runningPlacement.recordHash,
    placementDecisionId: input.runningPlacement.placementDecisionId,
    placementDecisionHash: input.runningPlacement.placementDecisionHash,
    reservationId: input.runningPlacement.reservationId,
    reservationHash: input.runningPlacement.reservationHash,
    allocationId: input.runningPlacement.allocationId,
    allocationHash: input.runningPlacement.allocationHash,
    startVerificationReceiptId: input.runningPlacement.startVerificationReceiptId,
    startVerificationReceiptHash: input.runningPlacement.startVerificationReceiptHash,
    startVerificationTrustAttestationId:
      input.runningPlacement.startVerificationTrustAttestationId,
    startVerificationTrustAttestationHash:
      input.runningPlacement.startVerificationTrustAttestationHash,
    verifiedAt: input.runningPlacement.startedVerifiedAt,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString()
  };
  return Object.freeze({ ...base, factHash: sha256Hex(base) });
}

export function assertJobVerifiedStartFact(
  fact: JobVerifiedStartFact,
  input: { jobId: string; scope: TrustedExecutionScope; now?: number }
) {
  const { factHash, ...base } = fact;
  const now = input.now ?? Date.now();
  if (
    sha256Hex(base) !== factHash
    || fact.source !== "phase34-verified-start"
    || fact.jobId !== input.jobId
    || Date.parse(fact.verifiedAt) > now
    || Date.parse(fact.issuedAt) > now
    || Date.parse(fact.expiresAt) <= now
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verified-start fact is stale, tampered, or bound to a different Job"
    );
  }
  assertScope(fact.portfolioId, fact.companyId, fact.environment, input.scope);
  return fact;
}

export function createJobVerifiedCompletionFact(input: {
  id: string;
  runningPlacement: VerifiedRunningPlacement;
  completion: VerifiedPlacementCompletion;
  scope: TrustedExecutionScope;
  bridgedAt: string;
}): JobVerifiedCompletionFact {
  assertRunningPlacementIntegrity(input.runningPlacement);
  assertCompletionIntegrity(input.completion, input.runningPlacement);
  assertScope(
    input.runningPlacement.portfolioId,
    input.runningPlacement.companyId,
    input.runningPlacement.environment,
    input.scope
  );

  const bridgedAt = parseTime(input.bridgedAt, "Job completion bridge time");
  const verifiedAt = parseTime(input.completion.verifiedAt, "Job completion verifiedAt");
  if (verifiedAt > bridgedAt) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Completion cannot be bridged before it is independently verified"
    );
  }

  const base: Omit<JobVerifiedCompletionFact, "factHash"> = {
    id: input.id,
    source: "phase34-verified-completion",
    portfolioId: input.runningPlacement.portfolioId,
    companyId: input.runningPlacement.companyId,
    environment: input.runningPlacement.environment,
    jobId: input.runningPlacement.jobId,
    runningPlacementId: input.runningPlacement.id,
    runningPlacementHash: input.runningPlacement.recordHash,
    completionId: input.completion.id,
    completionHash: input.completion.recordHash,
    completionVerificationReceiptId: input.completion.completionVerificationReceiptId,
    completionVerificationReceiptHash: input.completion.completionVerificationReceiptHash,
    completionVerificationTrustAttestationId:
      input.completion.completionVerificationTrustAttestationId,
    completionVerificationTrustAttestationHash:
      input.completion.completionVerificationTrustAttestationHash,
    verifiedAt: input.completion.verifiedAt,
    bridgedAt: new Date(bridgedAt).toISOString()
  };
  return Object.freeze({ ...base, factHash: sha256Hex(base) });
}

export function assertJobVerifiedCompletionFact(
  fact: JobVerifiedCompletionFact,
  input: {
    jobId: string;
    scope: TrustedExecutionScope;
    runningPlacementId?: string;
    runningPlacementHash?: string;
    now?: number;
  }
) {
  const { factHash, ...base } = fact;
  const now = input.now ?? Date.now();
  if (
    sha256Hex(base) !== factHash
    || fact.source !== "phase34-verified-completion"
    || fact.jobId !== input.jobId
    || Date.parse(fact.verifiedAt) > now
    || Date.parse(fact.bridgedAt) > now
    || (input.runningPlacementId && fact.runningPlacementId !== input.runningPlacementId)
    || (input.runningPlacementHash && fact.runningPlacementHash !== input.runningPlacementHash)
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verified completion fact is tampered or does not continue the Job start lineage"
    );
  }
  assertScope(fact.portfolioId, fact.companyId, fact.environment, input.scope);
  return fact;
}

export function createJobCompletionVerificationRequest(input: {
  id: string;
  fact: JobVerifiedCompletionFact;
  scope: TrustedExecutionScope;
  requestedAt: string;
  expiresAt: string;
  maxEvidenceAgeSeconds: number;
}): VerificationRequest {
  const requestedAt = parseTime(input.requestedAt, "Job completion verification requestedAt");
  assertJobVerifiedCompletionFact(input.fact, {
    jobId: input.fact.jobId,
    scope: input.scope,
    now: requestedAt
  });
  return createVerificationRequest({
    id: input.id,
    portfolioId: input.fact.portfolioId,
    companyId: input.fact.companyId,
    environment: input.fact.environment,
    subject: { type: "job", id: input.fact.jobId },
    strategies: ["execution"],
    requiresIndependentEvidence: false,
    maxEvidenceAgeSeconds: input.maxEvidenceAgeSeconds,
    requestedAt: input.requestedAt,
    expiresAt: input.expiresAt
  });
}

export function createJobCompletionVerificationEvidence(input: {
  id: string;
  fact: JobVerifiedCompletionFact;
  request: VerificationRequest;
  scope: TrustedExecutionScope;
  observedAt: string;
}): VerificationEvidence {
  assertVerificationRequestIntegrity(input.request);
  const observedAt = parseTime(input.observedAt, "Job completion verification evidence observedAt");
  assertJobVerifiedCompletionFact(input.fact, {
    jobId: input.request.subject.id,
    scope: input.scope,
    now: observedAt
  });
  if (
    input.request.subject.type !== "job"
    || input.request.subject.id !== input.fact.jobId
    || !input.request.strategies.includes("execution")
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Job completion verification request does not match the verified completion fact"
    );
  }
  return createVerificationEvidence({
    id: input.id,
    portfolioId: input.fact.portfolioId,
    companyId: input.fact.companyId,
    subject: input.request.subject,
    strategy: "execution",
    result: "pass",
    sourceType: "system-probe",
    sourceId: "job-execution-bridge",
    independenceKey: input.fact.factHash,
    observedAt: input.observedAt,
    payloadHash: input.fact.factHash,
    provenance: `phase34-job-completion-bridge:${input.fact.id}`
  });
}
