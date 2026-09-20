import { describe, expect, it } from "vitest";
import { evaluateResourcePolicy, type ResourcePolicy } from "@/lib/resources/policy";

const policy: ResourcePolicy = {
  id: "policy-default",
  allowedEnvironments: ["development", "staging", "production"],
  allowedDataClasses: [
    "PUBLIC",
    "INTERNAL",
    "CUSTOMER",
    "SENSITIVE",
    "PRODUCTION_CRITICAL",
    "REBUILDABLE",
    "TEMPORARY",
    "ARCHIVE",
    "BACKUP",
    "MODEL_ARTIFACT"
  ],
  allowedLocationClasses: ["HOME", "OFFICE", "CLOUD", "COLO", "PARTNER_DC"],
  allowedRegions: ["us-west"],
  minimumReliabilityTier: "STANDARD",
  requireEncryptionAtRest: true,
  requireEncryptionInTransit: true,
  requireFallback: false,
  allowedInterruptionClasses: ["INTERRUPTIBLE", "NON_INTERRUPTIBLE"]
};

describe("Phase 31 resource policy", () => {
  it("rejects a powerful HOME GPU for prohibited production customer data", () => {
    const result = evaluateResourcePolicy(policy, {
      environment: "production",
      dataClass: "CUSTOMER",
      locationClass: "HOME",
      region: "us-west",
      reliabilityTier: "CRITICAL",
      encryptedAtRest: true,
      encryptedInTransit: true,
      fallbackAvailable: true,
      interruptionClass: "NON_INTERRUPTIBLE",
      workloadClass: "gpu.inference"
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("home-production-customer-data-default-deny");
  });

  it("never lets price or speed override a hard policy constraint", () => {
    const result = evaluateResourcePolicy({
      ...policy,
      workloadDeny: ["gpu.inference"]
    }, {
      environment: "production",
      dataClass: "PUBLIC",
      locationClass: "CLOUD",
      region: "us-west",
      reliabilityTier: "CRITICAL",
      encryptedAtRest: true,
      encryptedInTransit: true,
      fallbackAvailable: true,
      interruptionClass: "NON_INTERRUPTIBLE",
      workloadClass: "gpu.inference"
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(["workload-explicitly-denied"]);
  });

  it("blocks a sole critical authoritative copy in a HOME failure domain", () => {
    const result = evaluateResourcePolicy(policy, {
      environment: "production",
      dataClass: "PRODUCTION_CRITICAL",
      locationClass: "HOME",
      region: "us-west",
      reliabilityTier: "HIGH",
      encryptedAtRest: true,
      encryptedInTransit: true,
      fallbackAvailable: false,
      interruptionClass: "NON_INTERRUPTIBLE",
      workloadClass: "storage.database",
      authoritativeStorageRole: "primary",
      soleDurableCopy: true
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("home-cannot-hold-sole-critical-authoritative-copy");
  });

  it("returns deterministic explainable hard-constraint reasons", () => {
    const facts = {
      environment: "production" as const,
      dataClass: "SENSITIVE" as const,
      locationClass: "CLOUD" as const,
      region: "eu-west",
      reliabilityTier: "BEST_EFFORT" as const,
      encryptedAtRest: false,
      encryptedInTransit: false,
      fallbackAvailable: false,
      interruptionClass: "INTERRUPTIBLE" as const,
      workloadClass: "batch"
    };

    expect(evaluateResourcePolicy(policy, facts).reasons).toEqual(
      evaluateResourcePolicy(policy, facts).reasons
    );
    expect(evaluateResourcePolicy(policy, facts).reasons).toEqual([
      "region-not-allowed",
      "reliability-tier-too-low",
      "encryption-at-rest-required",
      "encryption-in-transit-required"
    ]);
  });
});
