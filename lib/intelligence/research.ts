export type ResearchPurpose =
  | "competitor"
  | "pricing"
  | "seo"
  | "keywords"
  | "market"
  | "technology"
  | "public-customer-signal";

export interface ResearchMission {
  id: string;
  portfolioId: string;
  companyId: string;
  objectiveId?: string;
  topic: string;
  purpose: ResearchPurpose;
  schedule?: string;
  maxRequestsPerRun: number;
  maxCostCentsPerRun: number;
  rateWindowSeconds: number;
  maxRequestsPerWindow: number;
  maxCostCentsPerWindow: number;
  enabled: boolean;
}

export interface ResearchEvidence {
  id: string;
  missionId: string;
  portfolioId: string;
  companyId: string;
  objectiveId?: string;
  source: string;
  reference: string;
  retrievedAt: string;
  freshnessSeconds: number;
  confidence: number;
  scopeRelevance: number;
  provenance: string;
  summary: string;
  authority: "advisory";
  claimStatus: "unverified" | "corroborated";
}

export interface ResearchUsageSnapshot {
  missionId: string;
  runId: string;
  runRequests: number;
  runCostCents: number;
  windowRequests: number;
  windowCostCents: number;
  windowStartedAt: string;
  version: number;
}

export type ResearchAllowance =
  | {
      allowed: true;
      projectedRunRequests: number;
      projectedRunCostCents: number;
      projectedWindowRequests: number;
      projectedWindowCostCents: number;
    }
  | {
      allowed: false;
      reason:
        | "mission-disabled"
        | "run-request-limit"
        | "run-cost-limit"
        | "window-request-limit"
        | "window-cost-limit"
        | "invalid-cost";
    };

export interface ResearchQuotaStore {
  getUsage(input: {
    missionId: string;
    runId: string;
    now: string;
    rateWindowSeconds: number;
  }): Promise<ResearchUsageSnapshot>;
  reserve(input: {
    usage: ResearchUsageSnapshot;
    requestCostCents: number;
    expectedVersion: number;
  }): Promise<void>;
}

export interface ResearchRunFailure {
  status: "failed";
  authoritative: false;
  coreOperationsAffected: false;
  failureClass: "rate-limited" | "budget-blocked" | "provider-error" | "timeout" | "validation-error" | "unknown";
  message: string;
}

export interface ResearchRunSuccess<T> {
  status: "succeeded";
  authoritative: false;
  coreOperationsAffected: false;
  value: T;
}

export type ResearchExecutionResult<T> = ResearchRunSuccess<T> | ResearchRunFailure;

export function validateResearchMission(mission: ResearchMission) {
  const integerLimits = [
    mission.maxRequestsPerRun,
    mission.maxCostCentsPerRun,
    mission.rateWindowSeconds,
    mission.maxRequestsPerWindow,
    mission.maxCostCentsPerWindow
  ];

  if (integerLimits.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new TypeError("Research mission limits must be non-negative integers");
  }

  if (!mission.portfolioId || !mission.companyId || !mission.id || !mission.topic) {
    throw new TypeError("Research mission requires scoped identity and topic");
  }

  return mission;
}

export function evaluateResearchAllowance(
  mission: ResearchMission,
  usage: ResearchUsageSnapshot,
  requestCostCents: number
): ResearchAllowance {
  validateResearchMission(mission);

  if (!mission.enabled) return { allowed: false, reason: "mission-disabled" };
  if (!Number.isInteger(requestCostCents) || requestCostCents < 0) {
    return { allowed: false, reason: "invalid-cost" };
  }

  const projectedRunRequests = usage.runRequests + 1;
  const projectedRunCostCents = usage.runCostCents + requestCostCents;
  const projectedWindowRequests = usage.windowRequests + 1;
  const projectedWindowCostCents = usage.windowCostCents + requestCostCents;

  if (projectedRunRequests > mission.maxRequestsPerRun) {
    return { allowed: false, reason: "run-request-limit" };
  }
  if (projectedRunCostCents > mission.maxCostCentsPerRun) {
    return { allowed: false, reason: "run-cost-limit" };
  }
  if (projectedWindowRequests > mission.maxRequestsPerWindow) {
    return { allowed: false, reason: "window-request-limit" };
  }
  if (projectedWindowCostCents > mission.maxCostCentsPerWindow) {
    return { allowed: false, reason: "window-cost-limit" };
  }

  return {
    allowed: true,
    projectedRunRequests,
    projectedRunCostCents,
    projectedWindowRequests,
    projectedWindowCostCents
  };
}

export class ResearchMissionService {
  constructor(private readonly quotas: ResearchQuotaStore) {}

  async admitRequest(
    mission: ResearchMission,
    runId: string,
    requestCostCents: number,
    now = new Date()
  ): Promise<ResearchAllowance> {
    validateResearchMission(mission);
    const usage = await this.quotas.getUsage({
      missionId: mission.id,
      runId,
      now: now.toISOString(),
      rateWindowSeconds: mission.rateWindowSeconds
    });

    const allowance = evaluateResearchAllowance(mission, usage, requestCostCents);
    if (!allowance.allowed) return allowance;

    await this.quotas.reserve({
      usage,
      requestCostCents,
      expectedVersion: usage.version
    });
    return allowance;
  }
}

export function isResearchEvidenceStale(evidence: ResearchEvidence, now = Date.now()) {
  const retrievedAt = Date.parse(evidence.retrievedAt);
  if (!Number.isFinite(retrievedAt)) return true;
  return now - retrievedAt > evidence.freshnessSeconds * 1000;
}

export function isResearchEvidenceEligible(
  evidence: ResearchEvidence,
  scope: { portfolioId: string; companyId: string; objectiveId?: string }
) {
  return evidence.authority === "advisory"
    && evidence.portfolioId === scope.portfolioId
    && evidence.companyId === scope.companyId
    && (!scope.objectiveId || evidence.objectiveId === scope.objectiveId)
    && evidence.confidence >= 0
    && evidence.confidence <= 1
    && evidence.scopeRelevance >= 0
    && evidence.scopeRelevance <= 1;
}

export function researchEvidenceFreshness(evidence: ResearchEvidence, now = Date.now()) {
  return isResearchEvidenceStale(evidence, now) ? "stale" as const : "fresh" as const;
}

export async function runAdvisoryResearch<T>(
  operation: () => Promise<T>,
  classifyFailure: (error: unknown) => ResearchRunFailure["failureClass"] = () => "unknown"
): Promise<ResearchExecutionResult<T>> {
  try {
    return {
      status: "succeeded",
      authoritative: false,
      coreOperationsAffected: false,
      value: await operation()
    };
  } catch (error) {
    return {
      status: "failed",
      authoritative: false,
      coreOperationsAffected: false,
      failureClass: classifyFailure(error),
      message: error instanceof Error ? error.message : "Research operation failed"
    };
  }
}
