import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export type ResourceDataClass =
  | "PUBLIC"
  | "INTERNAL"
  | "CUSTOMER"
  | "SENSITIVE"
  | "PRODUCTION_CRITICAL"
  | "REBUILDABLE"
  | "TEMPORARY"
  | "ARCHIVE"
  | "BACKUP"
  | "MODEL_ARTIFACT";

export type ResourceLocationClass = "HOME" | "OFFICE" | "CLOUD" | "COLO" | "PARTNER_DC";
export type ResourceReliabilityTier = "BEST_EFFORT" | "STANDARD" | "HIGH" | "CRITICAL";
export type ResourceInterruptionClass = "INTERRUPTIBLE" | "NON_INTERRUPTIBLE";

export interface ResourcePolicy {
  id: string;
  allowedEnvironments: readonly TrustedExecutionScope["environment"][];
  allowedDataClasses: readonly ResourceDataClass[];
  allowedLocationClasses: readonly ResourceLocationClass[];
  allowedRegions?: readonly string[];
  minimumReliabilityTier: ResourceReliabilityTier;
  requireEncryptionAtRest: boolean;
  requireEncryptionInTransit: boolean;
  requireFallback: boolean;
  allowedInterruptionClasses: readonly ResourceInterruptionClass[];
  workloadAllow?: readonly string[];
  workloadDeny?: readonly string[];
  allowProductionCustomerOnHome?: boolean;
  allowSoleCriticalCopyOnHome?: boolean;
}

export interface ResourcePolicyFacts {
  environment: TrustedExecutionScope["environment"];
  dataClass: ResourceDataClass;
  locationClass: ResourceLocationClass;
  region?: string;
  reliabilityTier: ResourceReliabilityTier;
  encryptedAtRest: boolean;
  encryptedInTransit: boolean;
  fallbackAvailable: boolean;
  interruptionClass: ResourceInterruptionClass;
  workloadClass: string;
  authoritativeStorageRole?: "none" | "primary" | "secondary";
  soleDurableCopy?: boolean;
}

export interface ResourcePolicyResult {
  eligible: boolean;
  reasons: readonly string[];
  preferenceHints: readonly string[];
}

const reliabilityRank: Record<ResourceReliabilityTier, number> = {
  BEST_EFFORT: 0,
  STANDARD: 1,
  HIGH: 2,
  CRITICAL: 3
};

export function evaluateResourcePolicy(
  policy: ResourcePolicy,
  facts: ResourcePolicyFacts
): ResourcePolicyResult {
  const reasons: string[] = [];
  const preferenceHints: string[] = [];

  if (!policy.allowedEnvironments.includes(facts.environment)) {
    reasons.push("environment-not-allowed");
  }
  if (!policy.allowedDataClasses.includes(facts.dataClass)) {
    reasons.push("data-class-not-allowed");
  }
  if (!policy.allowedLocationClasses.includes(facts.locationClass)) {
    reasons.push("location-class-not-allowed");
  }
  if (policy.allowedRegions && (!facts.region || !policy.allowedRegions.includes(facts.region))) {
    reasons.push("region-not-allowed");
  }
  if (reliabilityRank[facts.reliabilityTier] < reliabilityRank[policy.minimumReliabilityTier]) {
    reasons.push("reliability-tier-too-low");
  }
  if (policy.requireEncryptionAtRest && !facts.encryptedAtRest) {
    reasons.push("encryption-at-rest-required");
  }
  if (policy.requireEncryptionInTransit && !facts.encryptedInTransit) {
    reasons.push("encryption-in-transit-required");
  }
  if (policy.requireFallback && !facts.fallbackAvailable) {
    reasons.push("fallback-required");
  }
  if (!policy.allowedInterruptionClasses.includes(facts.interruptionClass)) {
    reasons.push("interruption-class-not-allowed");
  }
  if (policy.workloadDeny?.includes(facts.workloadClass)) {
    reasons.push("workload-explicitly-denied");
  }
  if (policy.workloadAllow && !policy.workloadAllow.includes(facts.workloadClass)) {
    reasons.push("workload-not-allowlisted");
  }

  const productionCustomerLike = (
    facts.environment === "production"
    && (facts.dataClass === "CUSTOMER" || facts.dataClass === "SENSITIVE")
  );
  if (
    facts.locationClass === "HOME"
    && productionCustomerLike
    && !policy.allowProductionCustomerOnHome
  ) {
    reasons.push("home-production-customer-data-default-deny");
  }

  if (
    facts.locationClass === "HOME"
    && facts.dataClass === "PRODUCTION_CRITICAL"
    && facts.authoritativeStorageRole === "primary"
    && facts.soleDurableCopy
    && !policy.allowSoleCriticalCopyOnHome
  ) {
    reasons.push("home-cannot-hold-sole-critical-authoritative-copy");
  }

  if (facts.locationClass === "HOME") {
    preferenceHints.push("home-capacity-is-optional");
  }
  if (facts.fallbackAvailable) {
    preferenceHints.push("fallback-available");
  }
  if (facts.reliabilityTier === "HIGH" || facts.reliabilityTier === "CRITICAL") {
    preferenceHints.push("high-reliability");
  }

  return Object.freeze({
    eligible: reasons.length === 0,
    reasons: Object.freeze(reasons),
    preferenceHints: Object.freeze(preferenceHints)
  });
}
