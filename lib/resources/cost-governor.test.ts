import { describe, expect, it } from "vitest";
import {
  createCapacityEconomicSnapshot,
  evaluateCostCapacityGovernor,
  reconcileCostUsage,
  type ResourceBudgetBinding
} from "@/lib/resources/cost-governor";
import type { PlacementEvaluationReport } from "@/lib/resources/placement";

const now = Date.parse("2026-09-20T23:30:00Z");

const placementReport: PlacementEvaluationReport = {
  placementRequestId: "placement-1",
  evaluatedAt: "2026-09-20T23:29:00Z",
  eligibleCandidateIds: ["cloud-a", "cloud-b", "cloud-approval", "headroom"],
  candidates: [
    {
      resourceId: "cloud-a",
      eligible: true,
      rejectionReasons: [],
      policyReasons: [],
      explanation: ["eligible"],
      snapshotHash: "placement-cloud-a"
    },
    {
      resourceId: "cloud-b",
      eligible: true,
      rejectionReasons: [],
      policyReasons: [],
      explanation: ["eligible"],
      snapshotHash: "placement-cloud-b"
    },
    {
      resourceId: "cloud-approval",
      eligible: true,
      rejectionReasons: [],
      policyReasons: [],
      explanation: ["eligible"],
      snapshotHash: "placement-cloud-approval"
    },
    {
      resourceId: "headroom",
      eligible: true,
      rejectionReasons: [],
      policyReasons: [],
      explanation: ["eligible"],
      snapshotHash: "placement-headroom"
    },
    {
      resourceId: "cheap-but-forbidden",
      eligible: false,
      rejectionReasons: ["policy:data-class-not-allowed"],
      policyReasons: ["data-class-not-allowed"],
      explanation: [],
      snapshotHash: "placement-forbidden"
    }
  ],
  reportHash: "placement-report-hash"
};

const budget: ResourceBudgetBinding = {
  id: "budget-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  jobId: "job-1",
  hardCapCents: 100,
  approvalAboveCents: 60,
  status: "active"
};

function economics(
  resourceId: string,
  overrides: Partial<Parameters<typeof createCapacityEconomicSnapshot>[0]> = {}
) {
  return createCapacityEconomicSnapshot({
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
    quotaLimitUnits: 20,
    quotaUsedUnits: 4,
    effectiveHourlyCents: 20,
    marginalHourlyCents: 15,
    observedAt: "2026-09-20T23:29:00Z",
    expiresAt: "2026-09-20T23:35:00Z",
    ...overrides
  });
}

describe("Phase 35 cost and capacity governor", () => {
  it("ranks only placement-eligible candidates and cannot let cheap forbidden capacity win", () => {
    const report = evaluateCostCapacityGovernor({
      placementReport,
      portfolioId: "portfolio-a",
      companyId: "company-a",
      jobId: "job-1",
      budget,
      now,
      candidates: [
        {
          resourceId: "cloud-a",
          placementSnapshotHash: "placement-cloud-a",
          requestedDurationSeconds: 3600,
          economicSnapshot: economics("cloud-a", { effectiveHourlyCents: 30 })
        },
        {
          resourceId: "cloud-b",
          placementSnapshotHash: "placement-cloud-b",
          requestedDurationSeconds: 3600,
          economicSnapshot: economics("cloud-b", { effectiveHourlyCents: 20 })
        },
        {
          resourceId: "cheap-but-forbidden",
          placementSnapshotHash: "placement-forbidden",
          requestedDurationSeconds: 3600,
          economicSnapshot: economics("cheap-but-forbidden", { effectiveHourlyCents: 1 })
        }
      ]
    });

    expect(report.rankedAllowedCandidateIds).toEqual(["cloud-b", "cloud-a"]);
    expect(report.blockedCandidateIds).toContain("cheap-but-forbidden");
    expect(
      report.candidates.find((candidate) => candidate.resourceId === "cheap-but-forbidden")?.reasons
    ).toContain("placement-ineligible");
  });

  it("preserves protected headroom even when the candidate is otherwise eligible", () => {
    const report = evaluateCostCapacityGovernor({
      placementReport,
      portfolioId: "portfolio-a",
      companyId: "company-a",
      jobId: "job-1",
      budget,
      now,
      candidates: [{
        resourceId: "headroom",
        placementSnapshotHash: "placement-headroom",
        requestedDurationSeconds: 3600,
        economicSnapshot: economics("headroom", {
          totalUnits: 10,
          usedUnits: 5,
          reservedUnits: 2,
          protectedHeadroomUnits: 2,
          requestedUnits: 2
        })
      }]
    });

    expect(report.blockedCandidateIds).toEqual(["headroom"]);
    expect(report.candidates[0]?.reasons).toContain("protected-headroom-violation");
  });

  it("uses budget thresholds to require approval or block", () => {
    const report = evaluateCostCapacityGovernor({
      placementReport,
      portfolioId: "portfolio-a",
      companyId: "company-a",
      jobId: "job-1",
      budget,
      now,
      candidates: [
        {
          resourceId: "cloud-approval",
          placementSnapshotHash: "placement-cloud-approval",
          requestedDurationSeconds: 3600,
          economicSnapshot: economics("cloud-approval", { effectiveHourlyCents: 75 })
        },
        {
          resourceId: "cloud-a",
          placementSnapshotHash: "placement-cloud-a",
          requestedDurationSeconds: 3600,
          economicSnapshot: economics("cloud-a", { effectiveHourlyCents: 101 })
        }
      ]
    });

    expect(report.approvalRequiredCandidateIds).toEqual(["cloud-approval"]);
    expect(report.blockedCandidateIds).toEqual(["cloud-a"]);
  });

  it("tracks capacity class, utilization, quota and marginal/effective cost", () => {
    const snapshot = economics("cloud-a", {
      capacityClass: "spot-preemptible",
      totalUnits: 20,
      usedUnits: 10,
      reservedUnits: 2,
      requestedUnits: 3,
      effectiveHourlyCents: 18,
      marginalHourlyCents: 8
    });

    expect(snapshot.capacityClass).toBe("spot-preemptible");
    expect(snapshot.utilizationPct).toBe(50);
    expect(snapshot.marginalHourlyCents).toBe(8);
    expect(snapshot.effectiveHourlyCents).toBe(18);
  });

  it("reconciles estimated and actual job/resource cost and usage", () => {
    const reconciliation = reconcileCostUsage({
      jobId: "job-1",
      resourceId: "cloud-a",
      estimatedCostCents: 100,
      actualCostCents: 108,
      estimatedUsageUnits: 10,
      actualUsageUnits: 11,
      tolerancePct: 10
    });

    expect(reconciliation.costVarianceCents).toBe(8);
    expect(reconciliation.costVariancePct).toBe(8);
    expect(reconciliation.usageVarianceUnits).toBe(1);
    expect(reconciliation.withinCostTolerance).toBe(true);
    expect(reconciliation.reconciliationHash).toHaveLength(64);
  });
});
