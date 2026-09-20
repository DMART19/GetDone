import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";

export const PHASE44_DETERMINISTIC_HARNESS_VERSION = "1.0.0";

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
  if (new Set(actual).size !== expected.length || expected.some((id) => !actual.includes(id))) {
    throw new ControlPlaneError("INTERNAL", "Phase 44 deterministic attack matrix is incomplete");
  }
  return PHASE44_DETERMINISTIC_VECTORS;
}

export async function expectAttackRejected(
  attackId: Phase44AttackId,
  attempt: () => unknown | Promise<unknown>
): Promise<Phase44ProbeResult> {
  try {
    await attempt();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "attack rejected";
    const base = {
      attackId,
      disposition: "rejected" as const,
      blocked: true,
      detail
    };
    return Object.freeze({ ...base, resultHash: sha256Hex(base) });
  }
  throw new ControlPlaneError("FORBIDDEN", `Phase 44 attack was not rejected: ${attackId}`);
}

export function recordNonAuthoritativeEvidence(
  attackId: Phase44AttackId,
  detail: string
): Phase44ProbeResult {
  const base = {
    attackId,
    disposition: "accepted-as-non-authoritative-evidence" as const,
    blocked: true,
    detail
  };
  return Object.freeze({ ...base, resultHash: sha256Hex(base) });
}

export function recordIdempotentNoEscalation(
  attackId: Phase44AttackId,
  detail: string
): Phase44ProbeResult {
  const base = {
    attackId,
    disposition: "idempotent-no-escalation" as const,
    blocked: true,
    detail
  };
  return Object.freeze({ ...base, resultHash: sha256Hex(base) });
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
    sealedAt
  });
}

export function assertReleaseRegistryIntegrity(registry: unknown, seal: ReleaseRegistryIntegritySeal) {
  if (sha256Hex(registry) !== seal.registryHash) {
    throw new ControlPlaneError("FORBIDDEN", "Release registry tampering detected");
  }
  return registry;
}
