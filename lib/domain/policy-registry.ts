import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { POLICY_ENGINE_VERSION, POLICY_RULES_HASH } from "@/lib/planning/policy-engine";

export const POLICY_REGISTRY_ID = "getdone-core-policy";
export const CURRENT_POLICY_VERSION = "2026-09-28.2";

export const CURRENT_POLICY_REGISTRY_HASH = sha256Hex({
  id: POLICY_REGISTRY_ID,
  version: CURRENT_POLICY_VERSION,
  policyEngineVersion: POLICY_ENGINE_VERSION,
  policyRulesHash: POLICY_RULES_HASH
});

export interface PolicyRegistryReference {
  id: typeof POLICY_REGISTRY_ID;
  version: typeof CURRENT_POLICY_VERSION;
  registryHash: string;
  policyEngineVersion: string;
  policyRulesHash: string;
}

export function currentPolicyRegistryReference(): PolicyRegistryReference {
  return Object.freeze({
    id: POLICY_REGISTRY_ID,
    version: CURRENT_POLICY_VERSION,
    registryHash: CURRENT_POLICY_REGISTRY_HASH,
    policyEngineVersion: POLICY_ENGINE_VERSION,
    policyRulesHash: POLICY_RULES_HASH
  });
}

export function assertCurrentPolicyVersion(version: string) {
  if (version !== CURRENT_POLICY_VERSION) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      `Unknown or stale policy version: ${version}`
    );
  }
  return version;
}

export function assertPolicyRegistryReference(reference: PolicyRegistryReference) {
  if (
    reference.id !== POLICY_REGISTRY_ID
    || reference.version !== CURRENT_POLICY_VERSION
    || reference.registryHash !== CURRENT_POLICY_REGISTRY_HASH
    || reference.policyEngineVersion !== POLICY_ENGINE_VERSION
    || reference.policyRulesHash !== POLICY_RULES_HASH
  ) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Policy registry reference is stale or unrecognized"
    );
  }
  return reference;
}
