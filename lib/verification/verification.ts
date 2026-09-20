import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  assertTrustedExecutionScopeEqual,
  type TrustedExecutionScope
} from "@/lib/control-plane/trusted-execution-scope";

export type VerificationStrategy =
  | "execution"
  | "system"
  | "business"
  | "resource"
  | "deployment"
  | "custom";

export type VerificationTargetType =
  | "task"
  | "job"
  | "outcome"
  | "resource"
  | "deployment"
  | "event"
  | "other";

export type VerificationResult = "verified" | "failed" | "uncertain";

export interface VerificationRequest {
  id: string;
  scope: TrustedExecutionScope;
  targetType: VerificationTargetType;
  targetId: string;
  strategies: readonly VerificationStrategy[];
  minEvidenceCount: number;
  requireIndependentEvidence: boolean;
  maxEvidenceAgeSeconds: number;
  requestedAt: string;
  expiresAt: string;
  requestHash: string;
}

export type VerificationSourceAuthority =
  | "execution"
  | "provider"
  | "verifier"
  | "control-plane"
  | "human";

export interface VerificationEvidence {
  id: string;
  requestId: string;
  scope: TrustedExecutionScope;
  targetType: VerificationTargetType;
  targetId: string;
  strategy: VerificationStrategy;
  sourceId: string;
  sourceAuthority: VerificationSourceAuthority;
  observedAt: string;
  expiresAt?: string;
  payloadHash: string;
  evidenceHash: string;
}

export interface VerificationReceipt {
  id: string;
  requestId: string;
  requestHash: string;
  scope: TrustedExecutionScope;
  targetType: VerificationTargetType;
  targetId: string;
  result: VerificationResult;
  evidenceIds: readonly string[];
  evidenceHashes: readonly string[];
  independentSourceIds: readonly string[];
  reason: string;
  issuedAt: string;
  expiresAt: string;
  receiptHash: string;
}

function finiteTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

export function createVerificationRequest(
  input: Omit<VerificationRequest, "requestHash">
): VerificationRequest {
  if (!input.id || !input.targetId || input.strategies.length === 0) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verification requests require identity, target, and at least one strategy"
    );
  }
  if (!Number.isInteger(input.minEvidenceCount) || input.minEvidenceCount < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Verification evidence minimum must be >= 1");
  }
  if (!Number.isFinite(input.maxEvidenceAgeSeconds) || input.maxEvidenceAgeSeconds < 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Verification freshness window is invalid");
  }

  const requestedAt = finiteTime(input.requestedAt, "requestedAt");
  const expiresAt = finiteTime(input.expiresAt, "expiresAt");
  if (expiresAt <= requestedAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Verification request must expire after issue");
  }

  const base = {
    ...input,
    strategies: Object.freeze([...new Set(input.strategies)].sort())
  };
  return Object.freeze({
    ...base,
    requestHash: sha256Hex(base)
  });
}

export function assertVerificationRequest(
  request: VerificationRequest,
  now = Date.now()
) {
  const { requestHash, ...base } = request;
  if (sha256Hex(base) !== requestHash) {
    throw new ControlPlaneError("FORBIDDEN", "Verification request integrity check failed");
  }
  if (finiteTime(request.requestedAt, "requestedAt") > now || finiteTime(request.expiresAt, "expiresAt") <= now) {
    throw new ControlPlaneError("FORBIDDEN", "Verification request is stale or expired");
  }
  return request;
}

export function createVerificationEvidence(
  input: Omit<VerificationEvidence, "evidenceHash">
): VerificationEvidence {
  if (!input.id || !input.requestId || !input.targetId || !input.sourceId || !input.payloadHash) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verification evidence requires identity, request, target, source, and payload hash"
    );
  }
  finiteTime(input.observedAt, "observedAt");
  if (input.expiresAt) finiteTime(input.expiresAt, "expiresAt");

  const base = { ...input };
  return Object.freeze({
    ...base,
    evidenceHash: sha256Hex(base)
  });
}

export function assertVerificationEvidence(
  evidence: VerificationEvidence,
  request: VerificationRequest,
  now = Date.now()
) {
  const { evidenceHash, ...base } = evidence;
  if (sha256Hex(base) !== evidenceHash) {
    throw new ControlPlaneError("FORBIDDEN", "Verification evidence integrity check failed");
  }

  assertTrustedExecutionScopeEqual(request.scope, evidence.scope, {
    requireSameResource: Boolean(request.scope.resourceId || evidence.scope.resourceId)
  });

  if (
    evidence.requestId !== request.id
    || evidence.targetType !== request.targetType
    || evidence.targetId !== request.targetId
    || !request.strategies.includes(evidence.strategy)
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Verification evidence is out of request scope");
  }

  const observedAt = finiteTime(evidence.observedAt, "observedAt");
  if (observedAt > now || now - observedAt > request.maxEvidenceAgeSeconds * 1000) {
    throw new ControlPlaneError("FORBIDDEN", "Verification evidence is stale or from the future");
  }
  if (evidence.expiresAt && finiteTime(evidence.expiresAt, "expiresAt") <= now) {
    throw new ControlPlaneError("FORBIDDEN", "Verification evidence has expired");
  }
  return evidence;
}

function isIndependent(evidence: VerificationEvidence) {
  return evidence.sourceAuthority === "verifier"
    || evidence.sourceAuthority === "control-plane"
    || evidence.sourceAuthority === "human";
}

export function createVerificationReceipt(input: {
  id: string;
  request: VerificationRequest;
  evidence: readonly VerificationEvidence[];
  result: VerificationResult;
  reason: string;
  issuedAt: string;
  expiresAt: string;
}): VerificationReceipt {
  const issuedAt = finiteTime(input.issuedAt, "issuedAt");
  const expiresAt = finiteTime(input.expiresAt, "expiresAt");
  assertVerificationRequest(input.request, issuedAt);

  if (!input.id || !input.reason) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Verification receipt requires identity and reason");
  }
  if (expiresAt <= issuedAt || expiresAt > finiteTime(input.request.expiresAt, "request.expiresAt")) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verification receipt expiry must be inside the request validity window"
    );
  }

  for (const evidence of input.evidence) {
    assertVerificationEvidence(evidence, input.request, issuedAt);
  }

  const independentSourceIds = uniqueSorted(
    input.evidence.filter(isIndependent).map((item) => item.sourceId)
  );

  if (input.result === "verified") {
    if (input.evidence.length < input.request.minEvidenceCount) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Verified result has insufficient evidence");
    }
    if (input.request.requireIndependentEvidence && independentSourceIds.length === 0) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Verified result requires independent verification evidence"
      );
    }
  }

  if (input.result === "failed" && input.evidence.length === 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Failed verification requires evidence");
  }

  const base = {
    id: input.id,
    requestId: input.request.id,
    requestHash: input.request.requestHash,
    scope: input.request.scope,
    targetType: input.request.targetType,
    targetId: input.request.targetId,
    result: input.result,
    evidenceIds: Object.freeze(input.evidence.map((item) => item.id)),
    evidenceHashes: Object.freeze(input.evidence.map((item) => item.evidenceHash)),
    independentSourceIds: Object.freeze(independentSourceIds),
    reason: input.reason,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt
  };

  return Object.freeze({
    ...base,
    receiptHash: sha256Hex(base)
  });
}

export function assertVerificationReceipt(
  receipt: VerificationReceipt,
  input: {
    scope: TrustedExecutionScope;
    targetType: VerificationTargetType;
    targetId: string;
    expectedResult?: VerificationResult;
    now?: number;
  }
) {
  const { receiptHash, ...base } = receipt;
  if (sha256Hex(base) !== receiptHash) {
    throw new ControlPlaneError("FORBIDDEN", "Verification receipt integrity check failed");
  }

  assertTrustedExecutionScopeEqual(receipt.scope, input.scope, {
    requireSameResource: Boolean(receipt.scope.resourceId || input.scope.resourceId)
  });

  const now = input.now ?? Date.now();
  if (
    receipt.targetType !== input.targetType
    || receipt.targetId !== input.targetId
    || finiteTime(receipt.issuedAt, "issuedAt") > now
    || finiteTime(receipt.expiresAt, "expiresAt") <= now
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Verification receipt is stale or out of target scope");
  }
  if (input.expectedResult && receipt.result !== input.expectedResult) {
    throw new ControlPlaneError("FORBIDDEN", "Verification receipt result does not authorize this transition");
  }
  return receipt;
}
