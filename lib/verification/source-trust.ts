import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import {
  assertVerificationEvidenceIntegrity,
  assertVerificationReceipt,
  assertVerificationRequestIntegrity,
  isVerificationEvidenceFresh,
  type VerificationEvidence,
  type VerificationReceipt,
  type VerificationRequest,
  type VerificationStrategy
} from "@/lib/verification/verification";

export interface VerificationSourceBinding {
  id: string;
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  sourceType: VerificationEvidence["sourceType"];
  sourceId: string;
  allowedStrategies: readonly VerificationStrategy[];
  independenceDomain: string;
  status: "active" | "revoked" | "disabled";
  validFrom: string;
  expiresAt?: string;
  bindingHash: string;
}

export interface VerificationTrustAttestation {
  id: string;
  requestId: string;
  requestHash: string;
  receiptId: string;
  receiptHash: string;
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  subjectType: VerificationRequest["subject"]["type"];
  subjectId: string;
  evidenceHashes: readonly string[];
  sourceBindingHashes: readonly string[];
  independent: true;
  attestedAt: string;
  expiresAt: string;
  attestationHash: string;
}

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

export function createVerificationSourceBinding(
  input: Omit<VerificationSourceBinding, "bindingHash">
): VerificationSourceBinding {
  if (
    !input.id
    || !input.portfolioId
    || !input.companyId
    || !input.sourceId
    || !input.independenceDomain
    || input.allowedStrategies.length === 0
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verification source binding identity, scope, strategies, and independence domain are required"
    );
  }

  const validFrom = parseTime(input.validFrom, "Verification source binding validFrom");
  if (input.expiresAt && parseTime(input.expiresAt, "Verification source binding expiresAt") <= validFrom) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verification source binding expiry must follow validFrom"
    );
  }

  const base: Omit<VerificationSourceBinding, "bindingHash"> = {
    ...input,
    allowedStrategies: Object.freeze(
      [...new Set(input.allowedStrategies)].sort() as VerificationStrategy[]
    ),
    validFrom: new Date(validFrom).toISOString(),
    expiresAt: input.expiresAt
      ? new Date(parseTime(input.expiresAt, "Verification source binding expiresAt")).toISOString()
      : undefined
  };
  return Object.freeze({ ...base, bindingHash: sha256Hex(base) });
}

export function assertVerificationSourceBinding(
  binding: VerificationSourceBinding,
  input: {
    scope: TrustedExecutionScope;
    evidence: VerificationEvidence;
    now?: number;
  }
) {
  const { bindingHash, ...base } = binding;
  if (sha256Hex(base) !== bindingHash) {
    throw new ControlPlaneError("FORBIDDEN", "Verification source binding integrity check failed");
  }

  const now = input.now ?? Date.now();
  if (
    binding.status !== "active"
    || Date.parse(binding.validFrom) > now
    || (binding.expiresAt && Date.parse(binding.expiresAt) <= now)
    || binding.portfolioId !== input.scope.portfolioId
    || binding.companyId !== input.scope.companyId
    || binding.environment !== input.scope.environment
    || binding.sourceType !== input.evidence.sourceType
    || binding.sourceId !== input.evidence.sourceId
    || !binding.allowedStrategies.includes(input.evidence.strategy)
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification source is inactive, out of scope, or not authorized for this strategy"
    );
  }

  if (input.evidence.independenceKey !== binding.independenceDomain) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification evidence independence domain must come from the authoritative source binding"
    );
  }

  return binding;
}

export function createVerificationTrustAttestation(input: {
  id: string;
  request: VerificationRequest;
  receipt: VerificationReceipt;
  evidence: readonly VerificationEvidence[];
  sourceBindings: readonly VerificationSourceBinding[];
  scope: TrustedExecutionScope;
  attestedAt: string;
  ttlSeconds?: number;
}): VerificationTrustAttestation {
  assertVerificationRequestIntegrity(input.request);
  const attestedAt = parseTime(input.attestedAt, "Verification trust attestedAt");
  assertVerificationReceipt(input.receipt, {
    scope: input.scope,
    subject: input.request.subject,
    now: attestedAt,
    allowedVerdicts: ["verified"]
  });

  if (
    input.receipt.requestId !== input.request.id
    || input.request.portfolioId !== input.scope.portfolioId
    || input.request.companyId !== input.scope.companyId
    || input.request.environment !== input.scope.environment
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification trust attestation request/receipt scope is inconsistent"
    );
  }

  const evidenceByHash = new Map(input.evidence.map((item) => {
    assertVerificationEvidenceIntegrity(item);
    return [item.evidenceHash, item] as const;
  }));
  const bindingsBySource = new Map(
    input.sourceBindings.map((binding) => [
      `${binding.sourceType}:${binding.sourceId}`,
      binding
    ] as const)
  );

  const usedEvidence = input.receipt.evidenceHashes.map((hash) => {
    const evidence = evidenceByHash.get(hash);
    if (!evidence) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Verification receipt references evidence that is unavailable to the trust attestor"
      );
    }
    return evidence;
  });

  if (usedEvidence.length === 0) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verified receipt requires trusted evidence before it can authorize a start/completion boundary"
    );
  }

  const bindingHashes: string[] = [];
  for (const evidence of usedEvidence) {
    if (!isVerificationEvidenceFresh(input.request, evidence, attestedAt)) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Verification evidence is stale at trust-attestation time"
      );
    }
    if (
      evidence.portfolioId !== input.request.portfolioId
      || evidence.companyId !== input.request.companyId
      || evidence.subject.type !== input.request.subject.type
      || evidence.subject.id !== input.request.subject.id
      || !input.request.strategies.includes(evidence.strategy)
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Verification evidence does not match the authoritative verification request"
      );
    }

    const binding = bindingsBySource.get(`${evidence.sourceType}:${evidence.sourceId}`);
    if (!binding) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Verification evidence source has no authoritative source binding"
      );
    }

    assertVerificationSourceBinding(binding, {
      scope: input.scope,
      evidence,
      now: attestedAt
    });

    if (
      input.request.requiresIndependentEvidence
      && binding.independenceDomain === input.request.executionIndependenceKey
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Verification source belongs to the execution independence domain"
      );
    }
    bindingHashes.push(binding.bindingHash);
  }

  const ttlSeconds = input.ttlSeconds ?? 120;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 3600) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verification trust attestation TTL must be 1-3600 seconds"
    );
  }

  const expiresAtMs = Math.min(
    Date.parse(input.receipt.expiresAt),
    attestedAt + ttlSeconds * 1000
  );
  const base: Omit<VerificationTrustAttestation, "attestationHash"> = {
    id: input.id,
    requestId: input.request.id,
    requestHash: input.request.requestHash,
    receiptId: input.receipt.id,
    receiptHash: input.receipt.receiptHash,
    portfolioId: input.request.portfolioId,
    companyId: input.request.companyId,
    environment: input.request.environment,
    subjectType: input.request.subject.type,
    subjectId: input.request.subject.id,
    evidenceHashes: Object.freeze(uniqueSorted(input.receipt.evidenceHashes)),
    sourceBindingHashes: Object.freeze(uniqueSorted(bindingHashes)),
    independent: true,
    attestedAt: new Date(attestedAt).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString()
  };
  return Object.freeze({ ...base, attestationHash: sha256Hex(base) });
}

export function assertVerificationTrustAttestation(
  attestation: VerificationTrustAttestation,
  input: {
    request: VerificationRequest;
    receipt: VerificationReceipt;
    scope: TrustedExecutionScope;
    now?: number;
  }
) {
  const { attestationHash, ...base } = attestation;
  if (sha256Hex(base) !== attestationHash) {
    throw new ControlPlaneError("FORBIDDEN", "Verification trust attestation integrity check failed");
  }
  const now = input.now ?? Date.now();
  if (
    !attestation.independent
    || Date.parse(attestation.attestedAt) > now
    || Date.parse(attestation.expiresAt) <= now
    || attestation.requestId !== input.request.id
    || attestation.requestHash !== input.request.requestHash
    || attestation.receiptId !== input.receipt.id
    || attestation.receiptHash !== input.receipt.receiptHash
    || attestation.portfolioId !== input.scope.portfolioId
    || attestation.companyId !== input.scope.companyId
    || attestation.environment !== input.scope.environment
    || attestation.subjectType !== input.request.subject.type
    || attestation.subjectId !== input.request.subject.id
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification trust attestation is stale or outside authoritative lineage"
    );
  }
  return attestation;
}
