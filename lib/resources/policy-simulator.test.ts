import { describe, expect, it } from "vitest";
import {
  createCapacityEconomicSnapshot,
  type CostGovernorCandidate,
  type ResourceBudgetBinding
} from "@/lib/resources/cost-governor";
import {
  createPlacementCandidateSnapshot,
  createPlacementRequest,
  type PlacementCandidateSnapshot
} from "@/lib/resources/placement";
import type { ResourcePolicy } from "@/lib/resources/policy";
import {
  simulateResourcePolicy,
  type HistoricalAiGatewayObservation,
  type HistoricalPlacementObservation
} from "@/lib/resources/policy-simulator";

const now = Date.parse("2026-09-21T00:00:00Z");
const scope = {
  userId: "owner-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production" as const
};

const request = createPlacementRequest({
  id: "placement-sim",
  source: "control-plane",
  jobAuthorized: true,
  scope,
  jobId: "job-sim",
  jobAuthorizationHash: "job-auth-hash",
  requiredCapabilities: ["compute.cpu"],
  compute: { cpuCores: 2, memoryMb: 2048, architecture: "amd64" },
  priority: "normal",
  checkpointable: true,
  retryable: true,
  dataClass: "CUSTOMER",
  allowedRegions: ["us-west"],
  reliabilityTier: "STANDARD",
  fallbackRequired: false,
  maxJobCostCents: 200,
  idempotencyKey: "job-sim:placement",
  createdAt: "2026-09-20T23:55:00Z",
  expiresAt: "2026-09-21T00:10:00Z"
});

const policy: ResourcePolicy = {
  id: "sim-policy",
  allowedEnvironments: ["production"],
  allowedDataClasses: ["CUSTOMER"],
  allowedLocationClasses: ["HOME", "CLOUD", "COLO"],
  allowedRegions: ["us-west"],
  minimumReliabilityTier: "STANDARD",
  requireEncryptionAtRest: true,
  requireEncryptionInTransit: true,
  requireFallback: false,
  allowedInterruptionClasses: ["NON_INTERRUPTIBLE"]
};

function candidate(
  resourceId: string,
  overrides: Partial<Parameters<typeof createPlacementCandidateSnapshot>[0]> = {}
): PlacementCandidateSnapshot {
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
    healthObservedAt: "2026-09-20T23:59:30Z",
    validatedCapabilities: ["compute.cpu"],
    architecture: "amd64",
    profileExpiresAt: "2026-09-21T00:15:00Z",
    profileHash: `profile-${resourceId}`,
    availableCapacity: { cpuCores: 8, memoryMb: 16384 },
    capacityObservedAt: "2026-09-20T23:59:00Z",
    capacityExpiresAt: "2026-09-21T00:05:00Z",
    credentialAvailable: true,
    estimatedJobCostCents: 50,
    ...overrides
  });
}

function economics(
  resourceId: string,
  placementSnapshotHash: string,
  hourlyCost: number
): CostGovernorCandidate {
  return {
    resourceId,
    placementSnapshotHash,
    requestedDurationSeconds: 3600,
    economicSnapshot: createCapacityEconomicSnapshot({
      id: `econ-${resourceId}`,
      resourceId,
      portfolioId: "portfolio-a",
      companyId: "company-a",
      capacityClass: "variable-on-demand",
      totalUnits: 16,
      usedUnits: 4,
      reservedUnits: 2,
      protectedHeadroomUnits: 2,
      requestedUnits: 2,
      quotaLimitUnits: 32,
      quotaUsedUnits: 4,
      effectiveHourlyCents: hourlyCost,
      marginalHourlyCents: Math.max(0, hourlyCost - 5),
      observedAt: "2026-09-20T23:59:00Z",
      expiresAt: "2026-09-21T00:05:00Z"
    })
  };
}

const budget: ResourceBudgetBinding = {
  id: "budget-sim",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  jobId: "job-sim",
  hardCapCents: 200,
  approvalAboveCents: 100,
  status: "active"
};

const history: HistoricalPlacementObservation[] = [
  {
    label: "historical-observation",
    id: "hist-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    resourceId: "cloud-a",
    occurredAt: "2026-09-19T00:00:00Z",
    costCents: 40,
    utilizationPct: 55,
    queueMs: 100,
    failed: false,
    verifiedOutcome: true
  },
  {
    label: "historical-observation",
    id: "foreign-history",
    portfolioId: "portfolio-a",
    companyId: "company-b",
    resourceId: "cloud-b",
    occurredAt: "2026-09-19T00:00:00Z",
    costCents: 9999,
    utilizationPct: 99,
    queueMs: 9999,
    failed: true,
    verifiedOutcome: false
  }
];

const aiHistory: HistoricalAiGatewayObservation[] = [{
  label: "historical-observation",
  id: "ai-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  providerId: "provider-a",
  modelId: "model-a",
  role: "planner",
  occurredAt: "2026-09-19T00:00:00Z",
  costCents: 3,
  latencyMs: 250,
  success: true
}];

describe("Phase 40 zero-side-effect policy simulator", () => {
  it("simulates policy, economics, scheduler preferences and guardrails without side effects", () => {
    const cloudA = candidate("cloud-a");
    const cloudB = candidate("cloud-b", {
      reliabilityTier: "CRITICAL",
      availableCapacity: { cpuCores: 16, memoryMb: 32768 }
    });

    const result = simulateResourcePolicy({
      id: "simulation-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      request,
      candidates: [cloudA, cloudB],
      economicCandidates: [
        economics("cloud-a", cloudA.snapshotHash, 30),
        economics("cloud-b", cloudB.snapshotHash, 45)
      ],
      proposal: {
        source: "owner",
        policy,
        budget,
        scheduler: {
          costWeight: 0.4,
          reliabilityWeight: 0.4,
          capacityWeight: 0.2,
          preferredRegions: ["us-west"]
        },
        guardrails: {
          minimumEligibleCandidates: 2,
          maximumProjectedFailureRatePct: 5,
          minimumEligibleCpuCores: 20,
          maximumExpectedCostCents: 100
        }
      },
      historicalPlacements: history,
      historicalAiGateway: aiHistory,
      assumptions: ["one-hour-job"],
      now
    });

    expect(result.sideEffects).toEqual([]);
    expect(result.policyMutationApplied).toBe(false);
    expect(result.reservationAttempted).toBe(false);
    expect(result.dispatchAttempted).toBe(false);
    expect(result.secretLookupAttempted).toBe(false);
    expect(result.automaticPolicyPromotion).toBe(false);
    expect(result.projection.simulatedSchedulerOrder).toHaveLength(2);
    expect(result.projection.guardrailFindings.every((finding) => finding.satisfied)).toBe(true);
  });

  it("keeps historical facts separate from projections and excludes cross-company history", () => {
    const cloudA = candidate("cloud-a");
    const result = simulateResourcePolicy({
      id: "simulation-history",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      request,
      candidates: [cloudA],
      economicCandidates: [economics("cloud-a", cloudA.snapshotHash, 30)],
      proposal: {
        source: "owner",
        policy,
        budget,
        scheduler: { costWeight: 1, reliabilityWeight: 0, capacityWeight: 0 },
        guardrails: {}
      },
      historicalPlacements: history,
      historicalAiGateway: aiHistory,
      now
    });

    expect(result.historical.label).toBe("historical-summary");
    expect(result.projection.label).toBe("simulation-projection");
    expect(result.historical.placementSampleSize).toBe(1);
    expect(result.historical.averagePlacementCostCents).toBe(40);
    expect(result.projection.expectedCostCents).toBe(30);
    expect(result.uncertainty.level).toBe("high");
  });

  it("shows hard data policy impact even when HOME capacity is cheaper", () => {
    const home = candidate("home-gpu", {
      locationClass: "HOME",
      reliabilityTier: "CRITICAL",
      availableCapacity: { cpuCores: 64, memoryMb: 131072 }
    });
    const cloudA = candidate("cloud-a");

    const result = simulateResourcePolicy({
      id: "simulation-home",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      request,
      candidates: [home, cloudA],
      economicCandidates: [
        economics("home-gpu", home.snapshotHash, 1),
        economics("cloud-a", cloudA.snapshotHash, 30)
      ],
      proposal: {
        source: "owner",
        policy,
        budget,
        scheduler: { costWeight: 1, reliabilityWeight: 0, capacityWeight: 0 },
        guardrails: {}
      },
      historicalPlacements: [],
      historicalAiGateway: [],
      now
    });

    expect(result.projection.policyRejectedCandidateCount).toBe(1);
    expect(result.projection.simulatedSchedulerOrder.map((item) => item.resourceId))
      .toEqual(["cloud-a"]);
  });

  it("records AI Gateway model evidence for AI-recommended simulations", () => {
    const cloudA = candidate("cloud-a");
    const result = simulateResourcePolicy({
      id: "simulation-ai",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      request,
      candidates: [cloudA],
      economicCandidates: [economics("cloud-a", cloudA.snapshotHash, 30)],
      proposal: {
        source: "ai-recommendation",
        policy,
        budget,
        scheduler: { costWeight: 0.5, reliabilityWeight: 0.5, capacityWeight: 0 },
        guardrails: {},
        modelEvidence: {
          source: "ai-gateway",
          gatewayRequestId: "gateway-request-1",
          providerId: "provider-a",
          modelId: "model-a",
          routingPolicyVersion: "routing-v1",
          evidenceId: "evidence-1"
        }
      },
      historicalPlacements: [],
      historicalAiGateway: [],
      now
    });

    expect(result.modelEvidence?.modelId).toBe("model-a");
    expect(result.proposalSource).toBe("ai-recommendation");
    expect(result.automaticPolicyPromotion).toBe(false);
  });

  it("rejects AI recommendations that bypass recorded AI Gateway evidence", () => {
    const cloudA = candidate("cloud-a");
    expect(() => simulateResourcePolicy({
      id: "simulation-ai-invalid",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      request,
      candidates: [cloudA],
      economicCandidates: [economics("cloud-a", cloudA.snapshotHash, 30)],
      proposal: {
        source: "ai-recommendation",
        policy,
        budget,
        scheduler: { costWeight: 1, reliabilityWeight: 0, capacityWeight: 0 },
        guardrails: {}
      },
      historicalPlacements: [],
      historicalAiGateway: [],
      now
    })).toThrow();
  });
});
