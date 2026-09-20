import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { PlacementEvaluationReport } from "@/lib/resources/placement";

export type CapacityEconomicClass =
  | "owned"
  | "committed"
  | "reserved"
  | "spot-preemptible"
  | "variable-on-demand";

export interface CapacityEconomicSnapshot {
  id: string;
  resourceId: string;
  portfolioId: string;
  companyId: string;
  capacityClass: CapacityEconomicClass;
  totalUnits: number;
  usedUnits: number;
  reservedUnits: number;
  protectedHeadroomUnits: number;
  requestedUnits: number;
  quotaLimitUnits?: number;
  quotaUsedUnits?: number;
  effectiveHourlyCents: number;
  marginalHourlyCents: number;
  startupCostCents?: number;
  utilizationPct: number;
  observedAt: string;
  expiresAt: string;
  snapshotHash: string;
}

export type BudgetDisposition = "allow" | "approval-required" | "blocked";

export interface ResourceBudgetBinding {
  id: string;
  portfolioId: string;
  companyId: string;
  jobId?: string;
  hardCapCents: number;
  approvalAboveCents?: number;
  status: "active" | "disabled";
}

export interface CostGovernorCandidate {
  resourceId: string;
  placementSnapshotHash: string;
  requestedDurationSeconds: number;
  economicSnapshot: CapacityEconomicSnapshot;
}

export interface CostGovernorCandidateResult {
  resourceId: string;
  placementEligible: boolean;
  disposition: BudgetDisposition;
  estimatedJobCostCents: number;
  estimatedMarginalCostCents: number;
  utilizationPct: number;
  protectedHeadroomAfterUnits: number;
  quotaRemainingAfterUnits?: number;
  reasons: readonly string[];
  snapshotHash: string;
}

export interface CostGovernorReport {
  placementRequestId: string;
  portfolioId: string;
  companyId: string;
  evaluatedAt: string;
  expiresAt: string;
  rankedAllowedCandidateIds: readonly string[];
  approvalRequiredCandidateIds: readonly string[];
  blockedCandidateIds: readonly string[];
  candidates: readonly CostGovernorCandidateResult[];
  reportHash: string;
}

export interface CostUsageReconciliation {
  jobId: string;
  resourceId: string;
  estimatedCostCents: number;
  actualCostCents: number;
  costVarianceCents: number;
  costVariancePct?: number;
  estimatedUsageUnits: number;
  actualUsageUnits: number;
  usageVarianceUnits: number;
  withinCostTolerance: boolean;
  reconciliationHash: string;
}

function requireNonNegative(value: number | undefined, label: string) {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be non-negative`);
  }
}

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

export function createCapacityEconomicSnapshot(
  input: Omit<CapacityEconomicSnapshot, "utilizationPct" | "snapshotHash">
): CapacityEconomicSnapshot {
  requireNonNegative(input.totalUnits, "Total capacity");
  requireNonNegative(input.usedUnits, "Used capacity");
  requireNonNegative(input.reservedUnits, "Reserved capacity");
  requireNonNegative(input.protectedHeadroomUnits, "Protected headroom");
  requireNonNegative(input.requestedUnits, "Requested capacity");
  requireNonNegative(input.quotaLimitUnits, "Quota limit");
  requireNonNegative(input.quotaUsedUnits, "Quota used");
  requireNonNegative(input.effectiveHourlyCents, "Effective hourly cost");
  requireNonNegative(input.marginalHourlyCents, "Marginal hourly cost");
  requireNonNegative(input.startupCostCents, "Startup cost");

  if (input.totalUnits <= 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Total capacity must be positive");
  }
  if (input.usedUnits + input.reservedUnits > input.totalUnits) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Used and reserved capacity exceed total capacity");
  }
  if (
    input.quotaLimitUnits !== undefined
    && (input.quotaUsedUnits ?? 0) > input.quotaLimitUnits
  ) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Quota usage exceeds quota limit");
  }

  const observedAt = parseTime(input.observedAt, "Economic snapshot observedAt");
  const expiresAt = parseTime(input.expiresAt, "Economic snapshot expiresAt");
  if (expiresAt <= observedAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Economic snapshot expiry must follow observation");
  }

  const utilizationPct = Number(((input.usedUnits / input.totalUnits) * 100).toFixed(4));
  const base: Omit<CapacityEconomicSnapshot, "snapshotHash"> = {
    ...input,
    utilizationPct
  };
  return Object.freeze({ ...base, snapshotHash: sha256Hex(base) });
}

export function assertCapacityEconomicSnapshotIntegrity(snapshot: CapacityEconomicSnapshot) {
  const { snapshotHash, ...base } = snapshot;
  if (sha256Hex(base) !== snapshotHash) {
    throw new ControlPlaneError("FORBIDDEN", "Capacity economic snapshot integrity check failed");
  }
}

export function evaluateBudget(
  estimatedCostCents: number,
  binding: ResourceBudgetBinding
): { disposition: BudgetDisposition; reasons: readonly string[] } {
  requireNonNegative(estimatedCostCents, "Estimated job cost");
  requireNonNegative(binding.hardCapCents, "Budget hard cap");
  requireNonNegative(binding.approvalAboveCents, "Budget approval threshold");

  if (binding.status !== "active") {
    return Object.freeze({
      disposition: "blocked" as const,
      reasons: Object.freeze(["budget-binding-disabled"])
    });
  }
  if (
    binding.approvalAboveCents !== undefined
    && binding.approvalAboveCents > binding.hardCapCents
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Budget approval threshold cannot exceed the hard cap"
    );
  }
  if (estimatedCostCents > binding.hardCapCents) {
    return Object.freeze({
      disposition: "blocked" as const,
      reasons: Object.freeze(["budget-hard-cap-exceeded"])
    });
  }
  if (
    binding.approvalAboveCents !== undefined
    && estimatedCostCents > binding.approvalAboveCents
  ) {
    return Object.freeze({
      disposition: "approval-required" as const,
      reasons: Object.freeze(["budget-approval-threshold-exceeded"])
    });
  }
  return Object.freeze({
    disposition: "allow" as const,
    reasons: Object.freeze([])
  });
}

export function evaluateCostCapacityGovernor(input: {
  placementReport: PlacementEvaluationReport;
  portfolioId: string;
  companyId: string;
  jobId: string;
  candidates: readonly CostGovernorCandidate[];
  budget: ResourceBudgetBinding;
  now?: number;
}): CostGovernorReport {
  const now = input.now ?? Date.now();
  if (
    input.budget.portfolioId !== input.portfolioId
    || input.budget.companyId !== input.companyId
    || (input.budget.jobId && input.budget.jobId !== input.jobId)
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Budget binding is outside the governor scope");
  }

  const placementById = new Map(
    input.placementReport.candidates.map((candidate) => [candidate.resourceId, candidate])
  );
  const eligibleIds = new Set(input.placementReport.eligibleCandidateIds);

  const results = [...input.candidates]
    .sort((left, right) => left.resourceId.localeCompare(right.resourceId))
    .map((candidate): CostGovernorCandidateResult => {
      const placement = placementById.get(candidate.resourceId);
      const placementEligible = Boolean(placement && eligibleIds.has(candidate.resourceId));
      const reasons: string[] = [];
      const snapshot = candidate.economicSnapshot;
      assertCapacityEconomicSnapshotIntegrity(snapshot);

      if (
        snapshot.resourceId !== candidate.resourceId
        || snapshot.portfolioId !== input.portfolioId
        || snapshot.companyId !== input.companyId
      ) {
        throw new ControlPlaneError("FORBIDDEN", "Economic snapshot is outside governor scope");
      }
      if (
        !placement
        || placement.snapshotHash !== candidate.placementSnapshotHash
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Economic candidate does not match the authoritative placement snapshot"
        );
      }
      if (Date.parse(snapshot.observedAt) > now || Date.parse(snapshot.expiresAt) <= now) {
        reasons.push("economic-snapshot-stale");
      }
      if (!placementEligible) {
        reasons.push("placement-ineligible");
      }
      if (!Number.isFinite(candidate.requestedDurationSeconds) || candidate.requestedDurationSeconds <= 0) {
        throw new ControlPlaneError("VALIDATION_FAILED", "Requested duration must be positive");
      }

      const freeBefore = snapshot.totalUnits - snapshot.usedUnits - snapshot.reservedUnits;
      const protectedHeadroomAfterUnits = freeBefore - snapshot.requestedUnits;
      if (protectedHeadroomAfterUnits < snapshot.protectedHeadroomUnits) {
        reasons.push("protected-headroom-violation");
      }

      let quotaRemainingAfterUnits: number | undefined;
      if (snapshot.quotaLimitUnits !== undefined) {
        const quotaUsed = snapshot.quotaUsedUnits ?? 0;
        quotaRemainingAfterUnits = snapshot.quotaLimitUnits - quotaUsed - snapshot.requestedUnits;
        if (quotaRemainingAfterUnits < 0) {
          reasons.push("quota-exceeded");
        }
      }

      const durationHours = candidate.requestedDurationSeconds / 3600;
      const startupCost = snapshot.startupCostCents ?? 0;
      const estimatedJobCostCents = Math.ceil(
        snapshot.effectiveHourlyCents * durationHours + startupCost
      );
      const estimatedMarginalCostCents = Math.ceil(
        snapshot.marginalHourlyCents * durationHours + startupCost
      );

      const budgetResult = evaluateBudget(estimatedJobCostCents, input.budget);
      reasons.push(...budgetResult.reasons);

      const hardBlocked = reasons.some((reason) =>
        reason === "economic-snapshot-stale"
        || reason === "placement-ineligible"
        || reason === "protected-headroom-violation"
        || reason === "quota-exceeded"
        || reason === "budget-binding-disabled"
        || reason === "budget-hard-cap-exceeded"
      );

      const disposition: BudgetDisposition = hardBlocked
        ? "blocked"
        : budgetResult.disposition;

      return Object.freeze({
        resourceId: candidate.resourceId,
        placementEligible,
        disposition,
        estimatedJobCostCents,
        estimatedMarginalCostCents,
        utilizationPct: snapshot.utilizationPct,
        protectedHeadroomAfterUnits,
        quotaRemainingAfterUnits,
        reasons: Object.freeze(reasons),
        snapshotHash: snapshot.snapshotHash
      });
    });

  const rankedAllowedCandidateIds = results
    .filter((candidate) => candidate.disposition === "allow")
    .sort((left, right) =>
      left.estimatedJobCostCents - right.estimatedJobCostCents
      || left.estimatedMarginalCostCents - right.estimatedMarginalCostCents
      || left.utilizationPct - right.utilizationPct
      || left.resourceId.localeCompare(right.resourceId)
    )
    .map((candidate) => candidate.resourceId);

  const approvalRequiredCandidateIds = results
    .filter((candidate) => candidate.disposition === "approval-required")
    .sort((left, right) =>
      left.estimatedJobCostCents - right.estimatedJobCostCents
      || left.resourceId.localeCompare(right.resourceId)
    )
    .map((candidate) => candidate.resourceId);

  const blockedCandidateIds = results
    .filter((candidate) => candidate.disposition === "blocked")
    .map((candidate) => candidate.resourceId);

  const reportExpiresAt = Math.min(
    ...input.candidates.map((candidate) => Date.parse(candidate.economicSnapshot.expiresAt))
  );
  const base: Omit<CostGovernorReport, "reportHash"> = {
    placementRequestId: input.placementReport.placementRequestId,
    portfolioId: input.portfolioId,
    companyId: input.companyId,
    evaluatedAt: new Date(now).toISOString(),
    expiresAt: new Date(reportExpiresAt).toISOString(),
    rankedAllowedCandidateIds: Object.freeze(rankedAllowedCandidateIds),
    approvalRequiredCandidateIds: Object.freeze(approvalRequiredCandidateIds),
    blockedCandidateIds: Object.freeze(blockedCandidateIds),
    candidates: Object.freeze(results)
  };
  return Object.freeze({ ...base, reportHash: sha256Hex(base) });
}

export function reconcileCostUsage(input: {
  jobId: string;
  resourceId: string;
  estimatedCostCents: number;
  actualCostCents: number;
  estimatedUsageUnits: number;
  actualUsageUnits: number;
  tolerancePct?: number;
}): CostUsageReconciliation {
  requireNonNegative(input.estimatedCostCents, "Estimated cost");
  requireNonNegative(input.actualCostCents, "Actual cost");
  requireNonNegative(input.estimatedUsageUnits, "Estimated usage");
  requireNonNegative(input.actualUsageUnits, "Actual usage");
  const tolerancePct = input.tolerancePct ?? 10;
  requireNonNegative(tolerancePct, "Cost tolerance");

  const costVarianceCents = input.actualCostCents - input.estimatedCostCents;
  const costVariancePct = input.estimatedCostCents === 0
    ? undefined
    : Number(((costVarianceCents / input.estimatedCostCents) * 100).toFixed(4));
  const usageVarianceUnits = input.actualUsageUnits - input.estimatedUsageUnits;
  const withinCostTolerance = input.estimatedCostCents === 0
    ? input.actualCostCents === 0
    : Math.abs(costVariancePct ?? 0) <= tolerancePct;

  const base: Omit<CostUsageReconciliation, "reconciliationHash"> = {
    jobId: input.jobId,
    resourceId: input.resourceId,
    estimatedCostCents: input.estimatedCostCents,
    actualCostCents: input.actualCostCents,
    costVarianceCents,
    costVariancePct,
    estimatedUsageUnits: input.estimatedUsageUnits,
    actualUsageUnits: input.actualUsageUnits,
    usageVarianceUnits,
    withinCostTolerance
  };
  return Object.freeze({ ...base, reconciliationHash: sha256Hex(base) });
}


export function assertCostGovernorReportIntegrity(report: CostGovernorReport) {
  const { reportHash, ...base } = report;
  if (sha256Hex(base) !== reportHash) {
    throw new ControlPlaneError("FORBIDDEN", "Cost governor report integrity check failed");
  }

  const candidateIds = new Set(report.candidates.map((candidate) => candidate.resourceId));
  for (const resourceId of [
    ...report.rankedAllowedCandidateIds,
    ...report.approvalRequiredCandidateIds,
    ...report.blockedCandidateIds
  ]) {
    if (!candidateIds.has(resourceId)) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Cost governor report references a candidate outside its candidate set"
      );
    }
  }
  return report;
}

export function assertGovernorAllowsAutonomousScheduling(
  report: CostGovernorReport,
  input: {
    placementRequestId: string;
    portfolioId: string;
    companyId: string;
    resourceId: string;
    now?: number;
  }
) {
  assertCostGovernorReportIntegrity(report);
  const now = input.now ?? Date.now();
  if (
    Date.parse(report.evaluatedAt) > now
    || Date.parse(report.expiresAt) <= now
    || report.placementRequestId !== input.placementRequestId
    || report.portfolioId !== input.portfolioId
    || report.companyId !== input.companyId
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Cost governor report is outside scheduler scope");
  }

  if (report.approvalRequiredCandidateIds.includes(input.resourceId)) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Candidate requires approval and is not eligible for autonomous scheduling"
    );
  }
  if (
    report.blockedCandidateIds.includes(input.resourceId)
    || !report.rankedAllowedCandidateIds.includes(input.resourceId)
  ) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Candidate is not allowed by the cost/capacity governor"
    );
  }

  return report.candidates.find((candidate) => candidate.resourceId === input.resourceId)!;
}
