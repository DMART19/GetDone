export interface ResearchMission {
  id: string;
  portfolioId: string;
  companyId: string;
  topic: string;
  purpose: "competitor" | "pricing" | "seo" | "keywords" | "market" | "technology" | "public-customer-signal";
  schedule?: string;
  maxRequestsPerRun: number;
  maxCostCentsPerRun: number;
  enabled: boolean;
}

export interface ResearchEvidence {
  id: string;
  missionId: string;
  portfolioId: string;
  companyId: string;
  source: string;
  reference: string;
  retrievedAt: string;
  freshnessSeconds: number;
  confidence: number;
  scopeRelevance: number;
  provenance: string;
  summary: string;
}

export function isResearchEvidenceStale(evidence: ResearchEvidence, now = Date.now()) {
  const retrievedAt = Date.parse(evidence.retrievedAt);
  if (!Number.isFinite(retrievedAt)) return true;
  return now - retrievedAt > evidence.freshnessSeconds * 1000;
}

export function isResearchEvidenceEligible(
  evidence: ResearchEvidence,
  scope: { portfolioId: string; companyId: string }
) {
  return evidence.portfolioId === scope.portfolioId
    && evidence.companyId === scope.companyId
    && evidence.confidence >= 0
    && evidence.confidence <= 1
    && evidence.scopeRelevance >= 0
    && evidence.scopeRelevance <= 1;
}
