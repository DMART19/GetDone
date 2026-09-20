export const ADVERSARIAL_CONTRACT_VECTOR_VERSION = "1.0.0";

export interface AdversarialContractVector {
  id: string;
  boundary: "ai-gateway" | "integration" | "job-runtime" | "business-adapter" | "software-worker" | "resource-fabric" | "voice";
  attack: string;
  expected: string;
}

export const ADVERSARIAL_CONTRACT_VECTORS: readonly AdversarialContractVector[] = Object.freeze([
  {
    id: "ai-ineligible-fallback",
    boundary: "ai-gateway",
    attack: "Primary model fails and fallback lacks required capability/data/environment eligibility",
    expected: "Fallback is rejected; request returns NO_ELIGIBLE_MODEL or unavailable without weakening requirements"
  },
  {
    id: "ai-provider-kill-switch",
    boundary: "ai-gateway",
    attack: "Disabled provider remains first in configured route",
    expected: "Kill switch removes provider before model preference/ranking"
  },
  {
    id: "integration-cross-company",
    boundary: "integration",
    attack: "Company B attempts to consume Company A integration record",
    expected: "Trusted company scope mismatch fails closed"
  },
  {
    id: "integration-raw-secret",
    boundary: "integration",
    attack: "Raw token is supplied where credential binding reference is expected",
    expected: "Registry rejects raw credential-shaped material"
  },
  {
    id: "job-stale-lease",
    boundary: "job-runtime",
    attack: "Worker attempts heartbeat or work after lease expiry",
    expected: "Stale lease is rejected and recoverExpired remains the durable recovery path"
  },
  {
    id: "provider-accepted-is-not-job-success",
    boundary: "business-adapter",
    attack: "Business provider returns accepted/completed",
    expected: "Adapter result records jobStateMutationApplied=false; verification/JobService remain authoritative"
  },
  {
    id: "software-production-without-approval",
    boundary: "software-worker",
    attack: "Worker attempts production promotion after staging without promotion receipt",
    expected: "Production authorization transition fails closed"
  },
  {
    id: "reservation-internal-bypass",
    boundary: "resource-fabric",
    attack: "Feature code imports Resource Fabric internal modules to bypass stable public contracts",
    expected: "Dependency-boundary CI rejects the internal import"
  },
  {
    id: "voice-approval-bypass",
    boundary: "voice",
    attack: "Voice intent attempts approval, step-up, execution, or raw credential handling",
    expected: "Voice authority flags and dependency matrix fail closed"
  }
]);

export function assertAdversarialContractVectorSet() {
  const ids = new Set<string>();
  for (const vector of ADVERSARIAL_CONTRACT_VECTORS) {
    if (!vector.id || !vector.attack || !vector.expected || ids.has(vector.id)) {
      throw new Error("Adversarial contract vector set contains an invalid or duplicate vector");
    }
    ids.add(vector.id);
  }
  return ADVERSARIAL_CONTRACT_VECTORS;
}
