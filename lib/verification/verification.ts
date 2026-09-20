import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export type VerificationStrategy =
  | "execution"
  | "system"
  | "business"
  | "resource-start"
  | "resource-release"
  | "cost-reconciliation";

export type VerificationVerdict = "verified" | "failed" | "uncertain";

export type VerificationSubjectType =
  | "task"
  | "job"
  | "outcome"
  | "resource"
  | "placement"
  | "allocation";

export interface VerificationSubject {
  type: VerificationSubjectType;
  id: string;
}

export interface VerificationRequest {
  id: string;
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  subject: VerificationSubject;
  strategies: readonly VerificationStrategy[];
  requiresIndependentEvidence: boolean;
  executionIndependenceKey?: string;
  maxEvidenceAgeSeconds: number;
  requestedAt: string;
  expiresAt: string;
  requestHash: string;
}

export type VerificationEvidenceResult = "pass" | "fail" | "unknown";

export interface VerificationEvidence {
  id: string;
  portfolioId: string;
  companyId: string;
  subject: VerificationSubject;
  strategy: VerificationStrategy;
  result: VerificationEvidenceResult;
  sourceType:
    | "system-probe"
    | "provider"
    | "worker"
    | "business-metric"
    | "human"
    | "resource-agent";
  sourceId: string;
  independenceKey: string;
  observedAt: string;
  expiresAt?: string;
  payloadHash: string;
  provenance: string;
  confidence?: number;
  evidenceHash: string;
}

export interface VerificationStrategyResult {
  strategy: VerificationStrategy;
  verdict: VerificationVerdict;
  evidenceIds: readonly string[];
  evidenceHashes: readonly string[];
  reason: string;
}

export interface VerificationReceipt {
  id: string;
  requestId: string;
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  subject: VerificationSubject;
  verdict: VerificationVerdict;
  strategyResults: readonly VerificationStrategyResult[];
  evidenceIds: readonly string[];
  evidenceHashes: readonly string[];
  verifiedAt: string;
  expiresAt: string;
  receiptHash: string;
}

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", label + " must be a valid timestamp");
  }
  return parsed;
}

function sameSubject(left: VerificationSubject, right: VerificationSubject) {
  return left.type === right.type && left.id === right.id;
}

function uniqueSorted<T extends string>(values: readonly T[]) {
  return [...new Set(values)].sort() as T[];
}

function assertConfidence(confidence?: number) {
  if (
    confidence !== undefined
    && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verification evidence confidence must be between 0 and 1"
    );
  }
}

export function createVerificationRequest(
  input: Omit<VerificationRequest, "requestHash">
): VerificationRequest {
  const requestedAt = parseTime(input.requestedAt, "Verification requestedAt");
  const expiresAt = parseTime(input.expiresAt, "Verification expiresAt");

  if (expiresAt <= requestedAt) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verification request must expire after it is created"
    );
  }
  if (!Number.isFinite(input.maxEvidenceAgeSeconds) || input.maxEvidenceAgeSeconds < 0) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verification max evidence age must be non-negative"
    );
  }

  const strategies = Object.freeze(uniqueSorted(input.strategies));
  if (strategies.length === 0) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verification request requires at least one strategy"
    );
  }
  if (input.requiresIndependentEvidence && !input.executionIndependenceKey) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Independent verification requires the execution independence key"
    );
  }

  const base: Omit<VerificationRequest, "requestHash"> = {
    ...input,
    subject: Object.freeze({ ...input.subject }),
    strategies
  };
  return Object.freeze({
    ...base,
    requestHash: sha256Hex(base)
  });
}

export function assertVerificationRequestIntegrity(request: VerificationRequest) {
  const { requestHash, ...base } = request;
  if (sha256Hex(base) !== requestHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification request integrity check failed"
    );
  }
}

export function createVerificationEvidence(
  input: Omit<VerificationEvidence, "evidenceHash">
): VerificationEvidence {
  parseTime(input.observedAt, "Verification evidence observedAt");
  if (input.expiresAt) {
    const expiresAt = parseTime(input.expiresAt, "Verification evidence expiresAt");
    if (expiresAt <= Date.parse(input.observedAt)) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Verification evidence must expire after observation"
      );
    }
  }
  if (!input.payloadHash || !input.provenance || !input.sourceId || !input.independenceKey) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verification evidence requires source, independence, provenance, and payload hash"
    );
  }
  assertConfidence(input.confidence);

  const base: Omit<VerificationEvidence, "evidenceHash"> = {
    ...input,
    subject: Object.freeze({ ...input.subject })
  };
  return Object.freeze({
    ...base,
    evidenceHash: sha256Hex(base)
  });
}

export function assertVerificationEvidenceIntegrity(evidence: VerificationEvidence) {
  const { evidenceHash, ...base } = evidence;
  if (sha256Hex(base) !== evidenceHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification evidence integrity check failed"
    );
  }
}

export function isVerificationEvidenceFresh(
  request: VerificationRequest,
  evidence: VerificationEvidence,
  now = Date.now()
) {
  const observedAt = Date.parse(evidence.observedAt);
  const evidenceExpiresAt = evidence.expiresAt ? Date.parse(evidence.expiresAt) : Infinity;
  return (
    Number.isFinite(observedAt)
    && observedAt <= now
    && now - observedAt <= request.maxEvidenceAgeSeconds * 1000
    && evidenceExpiresAt > now
  );
}

function validateEvidenceForRequest(
  request: VerificationRequest,
  evidence: VerificationEvidence,
  now: number
) {
  assertVerificationEvidenceIntegrity(evidence);

  if (
    evidence.portfolioId !== request.portfolioId
    || evidence.companyId !== request.companyId
    || !sameSubject(evidence.subject, request.subject)
    || !request.strategies.includes(evidence.strategy)
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification evidence is outside the authoritative request scope"
    );
  }

  return isVerificationEvidenceFresh(request, evidence, now);
}

function resolveStrategy(
  request: VerificationRequest,
  strategy: VerificationStrategy,
  evidence: readonly VerificationEvidence[],
  now: number
): VerificationStrategyResult {
  const matching = evidence.filter((item) => {
    if (item.strategy !== strategy) return false;
    if (!validateEvidenceForRequest(request, item, now)) return false;
    if (
      request.requiresIndependentEvidence
      && item.independenceKey === request.executionIndependenceKey
    ) {
      return false;
    }
    return true;
  });

  const failures = matching.filter((item) => item.result === "fail");
  const passes = matching.filter((item) => item.result === "pass");

  if (failures.length > 0) {
    return Object.freeze({
      strategy,
      verdict: "failed",
      evidenceIds: Object.freeze(failures.map((item) => item.id).sort()),
      evidenceHashes: Object.freeze(failures.map((item) => item.evidenceHash).sort()),
      reason: "Fresh authoritative evidence reported failure"
    });
  }

  if (passes.length > 0) {
    return Object.freeze({
      strategy,
      verdict: "verified",
      evidenceIds: Object.freeze(passes.map((item) => item.id).sort()),
      evidenceHashes: Object.freeze(passes.map((item) => item.evidenceHash).sort()),
      reason: request.requiresIndependentEvidence
        ? "Fresh independent evidence verified the strategy"
        : "Fresh evidence verified the strategy"
    });
  }

  return Object.freeze({
    strategy,
    verdict: "uncertain",
    evidenceIds: Object.freeze([]),
    evidenceHashes: Object.freeze([]),
    reason: request.requiresIndependentEvidence
      ? "No fresh independent passing evidence is available"
      : "No fresh passing evidence is available"
  });
}

export function resolveVerificationRequest(
  request: VerificationRequest,
  evidence: readonly VerificationEvidence[],
  input: {
    receiptId: string;
    verifiedAt?: string;
    receiptTtlSeconds?: number;
  }
): VerificationReceipt {
  assertVerificationRequestIntegrity(request);

  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
  const now = parseTime(verifiedAt, "Verification receipt verifiedAt");
  const requestExpiresAt = Date.parse(request.expiresAt);

  if (now >= requestExpiresAt) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification request is expired"
    );
  }

  const results = request.strategies.map((strategy) =>
    resolveStrategy(request, strategy, evidence, now)
  );

  const verdict: VerificationVerdict = results.some((item) => item.verdict === "failed")
    ? "failed"
    : results.every((item) => item.verdict === "verified")
      ? "verified"
      : "uncertain";

  const evidenceIds = uniqueSorted(results.flatMap((item) => item.evidenceIds));
  const evidenceHashes = uniqueSorted(results.flatMap((item) => item.evidenceHashes));
  const ttlSeconds = Math.max(1, input.receiptTtlSeconds ?? request.maxEvidenceAgeSeconds);
  const expiresAtMs = Math.min(requestExpiresAt, now + ttlSeconds * 1000);

  const base: Omit<VerificationReceipt, "receiptHash"> = {
    id: input.receiptId,
    requestId: request.id,
    portfolioId: request.portfolioId,
    companyId: request.companyId,
    environment: request.environment,
    subject: Object.freeze({ ...request.subject }),
    verdict,
    strategyResults: Object.freeze(results),
    evidenceIds: Object.freeze(evidenceIds),
    evidenceHashes: Object.freeze(evidenceHashes),
    verifiedAt,
    expiresAt: new Date(expiresAtMs).toISOString()
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
    subject: VerificationSubject;
    now?: number;
    allowedVerdicts?: readonly VerificationVerdict[];
  }
) {
  const { receiptHash, ...base } = receipt;
  if (sha256Hex(base) !== receiptHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification receipt integrity check failed"
    );
  }

  const now = input.now ?? Date.now();
  if (
    receipt.portfolioId !== input.scope.portfolioId
    || receipt.companyId !== input.scope.companyId
    || receipt.environment !== input.scope.environment
    || !sameSubject(receipt.subject, input.subject)
    || Date.parse(receipt.verifiedAt) > now
    || Date.parse(receipt.expiresAt) <= now
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification receipt is stale or outside authoritative scope"
    );
  }

  const allowed = input.allowedVerdicts ?? ["verified"];
  if (!allowed.includes(receipt.verdict)) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification receipt verdict does not authorize this transition"
    );
  }

  return receipt;
}


export interface VerificationReceiptStore {
  getReceipt(id: string): Promise<VerificationReceipt | null>;
}

export async function requireAuthoritativeVerificationReceipt(
  store: VerificationReceiptStore,
  receiptId: string,
  input: Parameters<typeof assertVerificationReceipt>[1]
) {
  const receipt = await store.getReceipt(receiptId);
  if (!receipt) {
    throw new ControlPlaneError(
      "NOT_FOUND",
      "Authoritative verification receipt was not found"
    );
  }

  assertVerificationReceipt(receipt, input);
  return receipt;
}
