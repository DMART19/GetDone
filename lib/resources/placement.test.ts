import { describe, expect, it } from "vitest";
import {
  createOrReuseActivePlacementRequest,
  createPlacementCandidateSnapshot,
  createPlacementRequest,
  evaluatePlacementCandidates
} from "@/lib/resources/placement";
import type { ResourcePolicy } from "@/lib/resources/policy";

const now = Date.parse("2026-09-20T23:00:00Z");
const scope = {
  userId: "owner-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production" as const
};

const policy: ResourcePolicy = {
  id: "placement-policy",
  allowedEnvironments: ["production"],
  allowedDataClasses: ["PUBLIC", "INTERNAL", "CUSTOMER", "SENSITIVE"],
  allowedLocationClasses: ["CLOUD", "COLO"],
  allowedRegions: ["us-west"],
  minimumReliabilityTier: "STANDARD",
  requireEncryptionAtRest: true,
  requireEncryptionInTransit: true,
  requireFallback: false,
  allowedInterruptionClasses: ["INTERRUPTIBLE", "NON_INTERRUPTIBLE"]
};

function placement(overrides: Record<string, unknown> = {}) {
  return createPlacementRequest({
    id: "placement-1",
    source: "control-plane",
    jobAuthorized: true,
    scope,
    jobId: "job-1",
    jobAuthorizationHash: "authorization-hash",
    requiredCapabilities: ["compute.cpu", "worker.node"],
    compute: { cpuCores: 2, memoryMb: 2048, architecture: "amd64" },
    priority: "normal",
    checkpointable: true,
    retryable: true,
    dataClass: "INTERNAL",
    allowedRegions: ["us-west"],
    reliabilityTier: "STANDARD",
    fallbackRequired: false,
    maxJobCostCents: 50,
    excludedResourceIds: [],
    idempotencyKey: "job-1:compute",
    createdAt: "2026-09-20T22:55:00Z",
    expiresAt: "2026-09-20T23:05:00Z",
    ...overrides
  } as Parameters<typeof createPlacementRequest>[0]);
}

function candidate(
  resourceId: string,
  overrides: Record<string, unknown> = {}
) {
  return createPlacementCandidateSnapshot({
    resourceId,
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environmentPermissions: ["production"],
    locationClass: "CLOUD",
    region: "us-west",
    reliabilityTier: "HIGH",
    encryptedAtRest: true,
    encryptedInTransit: true,
    fallbackAvailable: true,
    interruptionClass: "NON_INTERRUPTIBLE",
    workloadClass: "compute.worker",
    healthStatus: "healthy",
    healthObservedAt: "2026-09-20T22:59:30Z",
    validatedCapabilities: ["compute.cpu", "worker.node"],
    architecture: "amd64",
    profileExpiresAt: "2026-09-20T23:10:00Z",
    profileHash: "profile-hash",
    availableCapacity: { cpuCores: 8, memoryMb: 16384 },
    capacityObservedAt: "2026-09-20T22:59:00Z",
    capacityExpiresAt: "2026-09-20T23:02:00Z",
    credentialAvailable: true,
    estimatedJobCostCents: 25,
    ...overrides
  } as Parameters<typeof createPlacementCandidateSnapshot>[0]);
}

describe("Phase 32 placement request and candidate evaluation", () => {
  it("only allows the control plane to create placement eligibility requests", () => {
    expect(() => placement({ source: "frontend" })).toThrow();
    expect(() => placement({ source: "ai-model" })).toThrow();
    expect(() => placement({ jobAuthorized: false })).toThrow();
  });

  it("reuses the same active logical idempotent placement request", () => {
    const first = placement();
    const duplicate = placement({ id: "placement-2", createdAt: "2026-09-20T22:56:00Z" });
    const result = createOrReuseActivePlacementRequest([first], duplicate, now);

    expect(result.reused).toBe(true);
    expect(result.request.id).toBe("placement-1");
  });

  it("rejects conflicting reuse of the same idempotency key", () => {
    const first = placement();
    const changed = placement({
      id: "placement-2",
      compute: { cpuCores: 4, memoryMb: 4096, architecture: "amd64" }
    });

    expect(() => createOrReuseActivePlacementRequest([first], changed, now)).toThrow();
  });

  it("rejects unauthorized, stale, unhealthy, under-capacity and policy-forbidden candidates", () => {
    const report = evaluatePlacementCandidates({
      request: placement(),
      policy,
      now,
      candidates: [
        candidate("foreign", { companyId: "company-b" }),
        candidate("stale", { healthObservedAt: "2026-09-20T22:30:00Z" }),
        candidate("unhealthy", { healthStatus: "degraded" }),
        candidate("small", { availableCapacity: { cpuCores: 1, memoryMb: 1024 } }),
        candidate("home", { locationClass: "HOME" })
      ]
    });

    expect(report.eligibleCandidateIds).toEqual([]);
    expect(report.candidates.find((item) => item.resourceId === "foreign")?.rejectionReasons)
      .toContain("scope:tenant-mismatch");
    expect(report.candidates.find((item) => item.resourceId === "stale")?.rejectionReasons)
      .toContain("health:not-fresh-and-healthy");
    expect(report.candidates.find((item) => item.resourceId === "unhealthy")?.rejectionReasons)
      .toContain("health:not-fresh-and-healthy");
    expect(report.candidates.find((item) => item.resourceId === "small")?.rejectionReasons)
      .toContain("capacity:insufficient");
    expect(report.candidates.find((item) => item.resourceId === "home")?.rejectionReasons)
      .toContain("policy:location-class-not-allowed");
  });

  it("requires pinned resources to pass all hard constraints", () => {
    const report = evaluatePlacementCandidates({
      request: placement({ pinnedResourceId: "pinned" }),
      policy,
      now,
      candidates: [
        candidate("pinned", { credentialAvailable: false }),
        candidate("other")
      ]
    });

    expect(report.eligibleCandidateIds).toEqual([]);
    expect(report.candidates.find((item) => item.resourceId === "pinned")?.rejectionReasons)
      .toContain("credential-environment:credential-unavailable");
    expect(report.candidates.find((item) => item.resourceId === "other")?.rejectionReasons)
      .toContain("scope:not-pinned-resource");
  });

  it("produces an explainable eligible candidate report without reserving or dispatching", () => {
    const report = evaluatePlacementCandidates({
      request: placement(),
      policy,
      now,
      candidates: [candidate("cloud-a")]
    });

    expect(report.eligibleCandidateIds).toEqual(["cloud-a"]);
    expect(report.candidates[0]?.explanation).toEqual([
      "eligible:trusted-scope",
      "eligible:policy-hard-constraints-passed",
      "eligible:fresh-healthy-resource",
      "eligible:validated-capabilities-and-capacity",
      "eligible:credential-and-environment-available",
      "eligible:within-cost-ceiling"
    ]);
    expect(report).not.toHaveProperty("reservationId");
    expect(report).not.toHaveProperty("dispatchId");
  });
});
