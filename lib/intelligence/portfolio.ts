import { ControlPlaneError } from "@/lib/control-plane/errors";

export interface CompanyPortfolioSnapshot {
  id: string;
  portfolioId: string;
  companyId: string;
  companyName: string;
  capturedAt: string;
  evidenceIds: readonly string[];
  metrics: {
    activeGoals: number;
    pendingDecisions: number;
    runningJobs: number;
    uncertainOutcomes: number;
    highAttentionSignals: number;
    healthyResources: number;
    degradedResources: number;
  };
}

export interface PortfolioSummaryScope {
  portfolioId: string;
  authorizedCompanyIds: readonly string[];
}

export interface PortfolioExecutiveSummary {
  portfolioId: string;
  generatedAt: string;
  companies: readonly CompanyPortfolioSnapshot[];
  totals: CompanyPortfolioSnapshot["metrics"];
  excludedUnauthorizedCount: number;
}

function parsedTime(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Portfolio snapshot timestamp is invalid");
  }
  return parsed;
}

function assertMetric(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      `Portfolio metric ${name} must be a non-negative integer`
    );
  }
}

export function validateCompanyPortfolioSnapshot(snapshot: CompanyPortfolioSnapshot) {
  if (!snapshot.id || !snapshot.portfolioId || !snapshot.companyId || !snapshot.companyName) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Portfolio snapshot requires identity, portfolio, company, and company name"
    );
  }
  parsedTime(snapshot.capturedAt);
  for (const [name, value] of Object.entries(snapshot.metrics)) {
    assertMetric(value, name);
  }
  return snapshot;
}

export function buildPortfolioExecutiveSummary(
  snapshots: readonly CompanyPortfolioSnapshot[],
  scope: PortfolioSummaryScope,
  options: { now?: number; maxAgeSeconds?: number } = {}
): PortfolioExecutiveSummary {
  const now = options.now ?? Date.now();
  const maxAgeSeconds = options.maxAgeSeconds ?? 300;
  const allowed = new Set(scope.authorizedCompanyIds);
  const latestByCompany = new Map<string, CompanyPortfolioSnapshot>();
  let excludedUnauthorizedCount = 0;

  for (const snapshot of snapshots) {
    validateCompanyPortfolioSnapshot(snapshot);

    if (snapshot.portfolioId !== scope.portfolioId || !allowed.has(snapshot.companyId)) {
      excludedUnauthorizedCount += 1;
      continue;
    }

    const capturedAt = parsedTime(snapshot.capturedAt);
    if (capturedAt > now || now - capturedAt > maxAgeSeconds * 1000) continue;

    const previous = latestByCompany.get(snapshot.companyId);
    if (!previous || Date.parse(previous.capturedAt) < capturedAt) {
      latestByCompany.set(snapshot.companyId, snapshot);
    }
  }

  const companies = [...latestByCompany.values()].sort((a, b) =>
    a.companyName.localeCompare(b.companyName)
  );

  const totals = companies.reduce<CompanyPortfolioSnapshot["metrics"]>(
    (total, company) => ({
      activeGoals: total.activeGoals + company.metrics.activeGoals,
      pendingDecisions: total.pendingDecisions + company.metrics.pendingDecisions,
      runningJobs: total.runningJobs + company.metrics.runningJobs,
      uncertainOutcomes: total.uncertainOutcomes + company.metrics.uncertainOutcomes,
      highAttentionSignals: total.highAttentionSignals + company.metrics.highAttentionSignals,
      healthyResources: total.healthyResources + company.metrics.healthyResources,
      degradedResources: total.degradedResources + company.metrics.degradedResources
    }),
    {
      activeGoals: 0,
      pendingDecisions: 0,
      runningJobs: 0,
      uncertainOutcomes: 0,
      highAttentionSignals: 0,
      healthyResources: 0,
      degradedResources: 0
    }
  );

  return Object.freeze({
    portfolioId: scope.portfolioId,
    generatedAt: new Date(now).toISOString(),
    companies: Object.freeze(companies.map((item) => Object.freeze({ ...item }))),
    totals: Object.freeze(totals),
    excludedUnauthorizedCount
  });
}
