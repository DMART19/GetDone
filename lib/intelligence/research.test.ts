import { describe, expect, it } from "vitest";
import { isResearchEvidenceEligible, isResearchEvidenceStale, type ResearchEvidence } from "@/lib/intelligence/research";

const evidence: ResearchEvidence = {
  id: "e-1",
  missionId: "m-1",
  portfolioId: "p-1",
  companyId: "c-1",
  source: "public-web",
  reference: "https://example.com/source",
  retrievedAt: "2026-09-20T15:55:00Z",
  freshnessSeconds: 600,
  confidence: 0.8,
  scopeRelevance: 0.9,
  provenance: "public-web:example",
  summary: "Example evidence"
};

describe("research evidence", () => {
  it("stays scoped to the correct company", () => {
    expect(isResearchEvidenceEligible(evidence, { portfolioId: "p-1", companyId: "c-1" })).toBe(true);
    expect(isResearchEvidenceEligible(evidence, { portfolioId: "p-1", companyId: "c-2" })).toBe(false);
  });

  it("labels stale evidence deterministically", () => {
    expect(isResearchEvidenceStale(evidence, Date.parse("2026-09-20T16:10:01Z"))).toBe(true);
  });
});
