import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";

export const PHASE44_DETERMINISTIC_HARNESS_VERSION = "1.1.0";

export type Phase44AttackId =
  | "voice-approval-bypass"
  | "staging-production-scope-misuse"
  | "forged-resource-capability"
  | "reservation-replay"
  | "scheduler-bypass"
  | "provider-success-spoofing"
  | "credential-scope-escalation"
  | "cross-company-contamination"
  | "release-registry-tampering"
  | "model-provider-authority-attempt";

export type Phase44ExpectedDisposition =
  | "rejected"
  | "idempotent-no-escalation"
  | "accepted-as-non-authoritative-evidence";

export interface Phase44AdversarialVector {
  id: Phase44AttackId;
  boundary: string;
  expectedDisposition: Phase44ExpectedDisposition;
  blocking: true;
}

export interface Phase44ProbeResult {
  attackId: Phase44AttackId;
  disposition: Phase44ExpectedDisposition;
  blocked: boolean;
  detail: string;
  resultHash: string;
}

export interface Phase44HarnessReport {
  harnessVersion: string;
  matrixHash: string;
  executedAt: string;
  resultHashes: readonly string[];
  passed: true;
  reportHash: string;
}

export const PHASE44_DETERMINISTIC_VECTORS: readonly Phase44AdversarialVector[] = Object.freeze([
  { id: "voice-approval-bypass", boundary: "voice/control-api", expectedDisposition: "rejected", blocking: true },
  { id: "staging-production-scope-misuse", boundary: "credential-broker", expectedDisposition: "rejected", blocking: true },
  { id: "forged-resource-capability", boundary: "resource-profiling", expectedDisposition: "rejected", blocking: true },
  { id: "reservation-replay", boundary: "capacity-ledger", expectedDisposition: "idempotent-no-escalation", blocking: true },
  { id: "scheduler-bypass", boundary: "dispatch-admission", expectedDisposition: "rejected", blocking: true },
  { id: "provider-success-spoofing", boundary: "adapter/verification", expectedDisposition: "accepted-as-non-authoritative-evidence", blocking: true },
  { id: "credential-scope-escalation", boundary: "credential-broker", expectedDisposition: "rejected", blocking: true },
  { id: "cross-company-contamination", boundary: "tenant-scope", expectedDisposition: "rejected", blocking: true },
  { id: "release-registry-tampering", boundary: "release-integrity", expectedDisposition: "rejected", blocking: true },
  { id: "model-provider-authority-attempt", boundary: "ai-gateway", expectedDisposition: "rejected", blocking: true }
]);

export const PHASE44_VECTOR_MATRIX_HASH = sha256Hex(PHASE44_DETERMINISTIC_VECTORS);

function vectorFor(attackId: Phase44AttackId) {
  const vector = PHASE44_DETERMINISTIC_VECTORS.find((item) => item.id === attackId);
  if (!vector) {
    throw new ControlPlaneError("INTERNAL", `Unknown Phase 44 attack vector: ${attackId}`);
  }
  return vector;
}

export function assertPhase44VectorCompleteness() {
  const expected: readonly Phase44AttackId[] = [
    "voice-approval-bypass",
    "staging-production-scope-misuse",
    "forged-resource-capability",
    "reservation-replay",
    "scheduler-bypass",
    "provider-success-spoofing",
    "credential-scope-escalation",
    "cross-company-contamination",
    "release-registry-tampering",
    "model-provider-authority-attempt"
  ];
  const actual = PHASE44_DETERMINISTIC_VECTORS.map((item) => item.id);
  if (
    new Set(actual).size !== expected.length
    || expected.some((id) => !actual.includes(id))
    || PHASE44_DETERMINISTIC_VECTORS.some((vector) => vector.blocking !== true)
  ) {
    throw new ControlPlaneError("INTERNAL", "Phase 44 deterministic attack matrix is incomplete");
  }
  return PHASE44_DETERMINISTIC_VECTORS;
}

export function assertPhase44ProbeResult(result: Phase44ProbeResult) {
  const { resultHash, ...base } = result;
  const vector = vectorFor(result.attackId);
  if (
    sha256Hex(base) !== resultHash
    || result.blocked !== true
    || !result.detail.trim()
    || result.disposition !== vector.expectedDisposition
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      `Phase 44 probe result does not satisfy blocking matrix: ${result.attackId}`
    );
  }
  return result;
}

function createProbeResult(input: Omit<Phase44ProbeResult, "resultHash">) {
  const base = { ...input };
  const result = Object.freeze({ ...base, resultHash: sha256Hex(base) });
  return assertPhase44ProbeResult(result);
}

export async function expectAttackRejected(
  attackId: Phase44AttackId,
  attempt: () => unknown | Promise<unknown>
): Promise<Phase44ProbeResult> {
  const vector = vectorFor(attackId);
  if (vector.expectedDisposition !== "rejected") {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      `Attack vector ${attackId} is not configured for rejection`
    );
  }
  try {
    await attempt();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "attack rejected";
    return createProbeResult({
      attackId,
      disposition: "rejected",
      blocked: true,
      detail
    });
  }
  throw new ControlPlaneError("FORBIDDEN", `Phase 44 attack was not rejected: ${attackId}`);
}

export function recordNonAuthoritativeEvidence(
  attackId: Phase44AttackId,
  detail: string
): Phase44ProbeResult {
  return createProbeResult({
    attackId,
    disposition: "accepted-as-non-authoritative-evidence",
    blocked: true,
    detail
  });
}

export function recordIdempotentNoEscalation(
  attackId: Phase44AttackId,
  detail: string
): Phase44ProbeResult {
  return createProbeResult({
    attackId,
    disposition: "idempotent-no-escalation",
    blocked: true,
    detail
  });
}

export function createPhase44HarnessReport(input: {
  results: readonly Phase44ProbeResult[];
  executedAt: string;
}): Phase44HarnessReport {
  assertPhase44VectorCompleteness();
  const executedAtMs = Date.parse(input.executedAt);
  if (!Number.isFinite(executedAtMs)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Phase 44 report executedAt is invalid");
  }
  if (input.results.length !== PHASE44_DETERMINISTIC_VECTORS.length) {
    throw new ControlPlaneError("FORBIDDEN", "Phase 44 report must contain every blocking vector exactly once");
  }
  const byId = new Map<Phase44AttackId, Phase44ProbeResult>();
  for (const result of input.results) {
    assertPhase44ProbeResult(result);
    if (byId.has(result.attackId)) {
      throw new ControlPlaneError("FORBIDDEN", `Duplicate Phase 44 result: ${result.attackId}`);
    }
    byId.set(result.attackId, result);
  }
  for (const vector of PHASE44_DETERMINISTIC_VECTORS) {
    if (!byId.has(vector.id)) {
      throw new ControlPlaneError("FORBIDDEN", `Missing Phase 44 result: ${vector.id}`);
    }
  }
  const ordered = PHASE44_DETERMINISTIC_VECTORS.map((vector) => byId.get(vector.id)!);
  const base = {
    harnessVersion: PHASE44_DETERMINISTIC_HARNESS_VERSION,
    matrixHash: PHASE44_VECTOR_MATRIX_HASH,
    executedAt: new Date(executedAtMs).toISOString(),
    resultHashes: Object.freeze(ordered.map((result) => result.resultHash)),
    passed: true as const
  };
  return Object.freeze({ ...base, reportHash: sha256Hex(base) });
}

export interface ReleaseRegistryIntegritySeal {
  registryHash: string;
  sealedAt: string;
}

export function createReleaseRegistryIntegritySeal(registry: unknown, sealedAt: string): ReleaseRegistryIntegritySeal {
  if (!Number.isFinite(Date.parse(sealedAt))) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Release registry seal time is invalid");
  }
  return Object.freeze({
    registryHash: sha256Hex(registry),
    sealedAt: new Date(Date.parse(sealedAt)).toISOString()
  });
}

export function assertReleaseRegistryIntegrity(registry: unknown, seal: ReleaseRegistryIntegritySeal) {
  if (sha256Hex(registry) !== seal.registryHash) {
    throw new ControlPlaneError("FORBIDDEN", "Release registry tampering detected");
  }
  return registry;
}
