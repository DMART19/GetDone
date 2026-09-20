import { describe, expect, it } from "vitest";
import {
  evaluateResearchAllowance,
  isResearchEvidenceEligible,
  isResearchEvidenceStale,
  ResearchMissionService,
  runAdvisoryResearch,
  type ResearchEvidence,
  type ResearchMission,
  type ResearchQuotaStore,
  type ResearchUsageSnapshot
} from "@/lib/intelligence/research";

const mission: ResearchMission = {
  id: "mission-1",
  portfolioId: "p-1",
  companyId: "c-1",
  objectiveId: "objective-1",
  topic: "warehouse software competitors",
  purpose: "competitor",
  maxRequestsPerRun: 3,
  maxCostCentsPerRun: 100,
  rateWindowSeconds: 3600,
  maxRequestsPerWindow: 5,
  maxCostCentsPerWindow: 150,
  enabled: true
};

const evidence: ResearchEvidence = {
  id: "e-1",
  missionId: "mission-1",
  portfolioId: "p-1",
  companyId: "c-1",
  objectiveId: "objective-1",
  source: "public-web",
  reference: "https://example.com/source",
  retrievedAt: "2026-09-20T15:55:00Z",
  freshnessSeconds: 600,
  confidence: 0.8,
  scopeRelevance: 0.9,
  provenance: "public-web:example",
  summary: "Example evidence",
  authority: "advisory",
  claimStatus: "unverified"
};

function usage(overrides: Partial<ResearchUsageSnapshot> = {}): ResearchUsageSnapshot {
  return {
    missionId: "mission-1",
    runId: "run-1",
    runRequests: 0,
    runCostCents: 0,
    windowRequests: 0,
    windowCostCents: 0,
    windowStartedAt: "2026-09-20T15:00:00Z",
    version: 1,
    ...overrides
  };
}

describe("research mission controls", () => {
  it("stays scoped to the correct company/objective and remains advisory", () => {
    expect(isResearchEvidenceEligible(evidence, {
      portfolioId: "p-1",
      companyId: "c-1",
      objectiveId: "objective-1"
    })).toBe(true);

    expect(isResearchEvidenceEligible(evidence, {
      portfolioId: "p-1",
      companyId: "c-2",
      objectiveId: "objective-1"
    })).toBe(false);
  });

  it("labels stale evidence deterministically", () => {
    expect(isResearchEvidenceStale(evidence, Date.parse("2026-09-20T16:10:01Z"))).toBe(true);
  });

  it("enforces per-run request and cost budgets", () => {
    expect(evaluateResearchAllowance(mission, usage({ runRequests: 3 }), 1)).toEqual({
      allowed: false,
      reason: "run-request-limit"
    });

    expect(evaluateResearchAllowance(mission, usage({ runCostCents: 95 }), 10)).toEqual({
      allowed: false,
      reason: "run-cost-limit"
    });
  });

  it("enforces rate-window request and cost limits", () => {
    expect(evaluateResearchAllowance(mission, usage({ windowRequests: 5 }), 1)).toEqual({
      allowed: false,
      reason: "window-request-limit"
    });

    expect(evaluateResearchAllowance(mission, usage({ windowCostCents: 145 }), 10)).toEqual({
      allowed: false,
      reason: "window-cost-limit"
    });
  });

  it("reserves quota using optimistic durable-store semantics", async () => {
    let current = usage();
    const store: ResearchQuotaStore = {
      async getUsage() {
        return { ...current };
      },
      async reserve({ usage: snapshot, requestCostCents, expectedVersion }) {
        if (current.version !== expectedVersion) throw new Error("quota concurrency conflict");
        current = {
          ...snapshot,
          runRequests: snapshot.runRequests + 1,
          runCostCents: snapshot.runCostCents + requestCostCents,
          windowRequests: snapshot.windowRequests + 1,
          windowCostCents: snapshot.windowCostCents + requestCostCents,
          version: snapshot.version + 1
        };
      }
    };

    const result = await new ResearchMissionService(store).admitRequest(
      mission,
      "run-1",
      25,
      new Date("2026-09-20T16:00:00Z")
    );

    expect(result.allowed).toBe(true);
    expect(current.runRequests).toBe(1);
    expect(current.runCostCents).toBe(25);
  });

  it("converts research-provider failure into non-authoritative advisory failure", async () => {
    const result = await runAdvisoryResearch(
      async () => { throw new Error("provider unavailable"); },
      () => "provider-error"
    );

    expect(result).toEqual({
      status: "failed",
      authoritative: false,
      coreOperationsAffected: false,
      failureClass: "provider-error",
      message: "provider unavailable"
    });
  });
});
