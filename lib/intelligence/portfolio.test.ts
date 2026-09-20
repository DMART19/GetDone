import { describe, expect, it } from "vitest";
import {
  buildPortfolioExecutiveSummary,
  type CompanyPortfolioSnapshot
} from "@/lib/intelligence/portfolio";

const now = Date.parse("2026-09-20T21:00:00Z");

function snapshot(companyId: string, companyName: string): CompanyPortfolioSnapshot {
  return {
    id: `snapshot-${companyId}`,
    portfolioId: "portfolio-a",
    companyId,
    companyName,
    capturedAt: "2026-09-20T20:59:00Z",
    evidenceIds: [`evidence-${companyId}`],
    metrics: {
      activeGoals: 1,
      pendingDecisions: 2,
      runningJobs: 3,
      uncertainOutcomes: 0,
      highAttentionSignals: 1,
      healthyResources: 2,
      degradedResources: 0
    }
  };
}

describe("portfolio executive summary", () => {
  it("preserves company attribution while aggregating only authorized companies", () => {
    const result = buildPortfolioExecutiveSummary([
      snapshot("company-a", "Alpha"),
      snapshot("company-b", "Beta"),
      snapshot("company-c", "Hidden")
    ], {
      portfolioId: "portfolio-a",
      authorizedCompanyIds: ["company-a", "company-b"]
    }, { now });

    expect(result.companies.map((item) => item.companyId)).toEqual(["company-a", "company-b"]);
    expect(result.totals.runningJobs).toBe(6);
    expect(result.excludedUnauthorizedCount).toBe(1);
  });

  it("does not leak a different portfolio into the summary", () => {
    const foreign = {
      ...snapshot("company-z", "Foreign"),
      portfolioId: "portfolio-z"
    };

    const result = buildPortfolioExecutiveSummary([foreign], {
      portfolioId: "portfolio-a",
      authorizedCompanyIds: ["company-z"]
    }, { now });

    expect(result.companies).toHaveLength(0);
    expect(result.excludedUnauthorizedCount).toBe(1);
  });

  it("uses only the latest fresh snapshot per company", () => {
    const older = {
      ...snapshot("company-a", "Alpha"),
      id: "older",
      capturedAt: "2026-09-20T20:58:00Z",
      metrics: { ...snapshot("company-a", "Alpha").metrics, runningJobs: 9 }
    };
    const latest = snapshot("company-a", "Alpha");

    const result = buildPortfolioExecutiveSummary([older, latest], {
      portfolioId: "portfolio-a",
      authorizedCompanyIds: ["company-a"]
    }, { now });

    expect(result.companies).toHaveLength(1);
    expect(result.totals.runningJobs).toBe(3);
  });
});
