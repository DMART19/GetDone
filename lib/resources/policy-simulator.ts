import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  evaluateCostCapacityGovernor,
  type CostGovernorCandidate,
  type ResourceBudgetBinding
} from "@/lib/resources/cost-governor";
import {
  evaluatePlacementCandidates,
  type PlacementCandidateSnapshot,
  type PlacementRequestRecord
} from "@/lib/resources/placement";
import type {
  ResourcePolicy,
  ResourceReliabilityTier
} from "@/lib/resources/policy";

export interface HistoricalPlacementObservation {
  label: "historical-observation";
  id: string;
  portfolioId: string;
  companyId: string;
  resourceId: string;
  occurredAt: string;
  costCents: number;
  utilizationPct: number;
  queueMs: number;
  failed: boolean;
  verifiedOutcome: boolean;
}

export interface HistoricalAiGatewayObservation {
  label: "historical-observation";
  id: string;
  portfolioId: string;
  companyId: string;
  providerId: string;
  modelId: string;
  role: string;
  occurredAt: string;
  costCents: number;
  latencyMs: number;
  success: boolean;
}

export interface SimulationSchedulerPreferences {
  costWeight: number;
  reliabilityWeight: number;
  capacityWeight: number;
  preferredRegions?: readonly string[];
}

export interface SimulationGuardrails {
  minimumEligibleCandidates?: number;
  maximumProjectedFailureRatePct?: number;
  minimumEligibleCpuCores?: number;
  maximumExpectedCostCents?: number;
}

export interface SimulationModelEvidence {
  source: "ai-gateway";
  gatewayRequestId: string;
  providerId: string;
  modelId: string;
  routingPolicyVersion: string;
  evidenceId: string;
}

export interface ResourcePolicySimulationProposal {
  source: "owner" | "control-plane" | "ai-recommendation";
  policy: ResourcePolicy;
  budget: ResourceBudgetBinding;
  scheduler: SimulationSchedulerPreferences;
  guardrails: SimulationGuardrails;
  modelEvidence?: SimulationModelEvidence;
}

export interface HistoricalSimulationSummary {
  label: "historical-summary";
  placementSampleSize: number;
  aiGatewaySampleSize: number;
  averagePlacementCostCents?: number;
  averageUtilizationPct?: number;
  averageQueueMs?: number;
  placementFailureRatePct?: number;
  verifiedOutcomeRatePct?: number;
  averageAiGatewayCostCents?: number;
  averageAiGatewayLatencyMs?: number;
  aiGatewaySuccessRatePct?: number;
}

export interface SimulatedSchedulerCandidate {
  resourceId: string;
  score: number;
  disposition: "allow" | "approval-required";
  estimatedJobCostCents: number;
  reliabilityTier: ResourceReliabilityTier;
  availableCpuCores: number;
  preferredRegion: boolean;
}

export interface SimulationGuardrailFinding {
  guardrail: string;
  satisfied: boolean;
  observed?: number;
  required?: number;
}

export interface SimulationProjection {
  label: "simulation-projection";
  expectedCostCents?: number;
  expectedReliabilityPct?: number;
  projectedFailureRatePct?: number;
  eligibleCapacityCpuCores: number;
  placementEligibleCandidateCount: number;
  economicallyAllowedCandidateCount: number;
  approvalRequiredCandidateCount: number;
  policyRejectedCandidateCount: number;
  simulatedSchedulerOrder: readonly SimulatedSchedulerCandidate[];
  guardrailFindings: readonly SimulationGuardrailFinding[];
}

export interface SimulationUncertainty {
  level: "low" | "medium" | "high";
  reasons: readonly string[];
  placementSampleSize: number;
  aiGatewaySampleSize: number;
}

export interface ResourcePolicySimulationResult {
  id: string;
  portfolioId: string;
  companyId: string;
  placementRequestId: string;
  proposalSource: ResourcePolicySimulationProposal["source"];
  modelEvidence?: SimulationModelEvidence;
  historical: HistoricalSimulationSummary;
  projection: SimulationProjection;
  assumptions: readonly string[];
  uncertainty: SimulationUncertainty;
  policyMutationApplied: false;
  reservationAttempted: false;
  dispatchAttempted: false;
  secretLookupAttempted: false;
  automaticPolicyPromotion: false;
  sideEffects: readonly never[];
  simulationHash: string;
}

function requireNonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be non-negative`);
  }
}

function average(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

function percentage(part: number, total: number): number | undefined {
  if (total === 0) return undefined;
  return Number(((part / total) * 100).toFixed(4));
}

function reliabilityValue(tier: ResourceReliabilityTier) {
  const values: Record<ResourceReliabilityTier, number> = {
    BEST_EFFORT: 90,
    STANDARD: 97,
    HIGH: 99,
    CRITICAL: 99.9
  };
  return values[tier];
}

function validateSchedulerPreferences(preferences: SimulationSchedulerPreferences) {
  requireNonNegative(preferences.costWeight, "Scheduler cost weight");
  requireNonNegative(preferences.reliabilityWeight, "Scheduler reliability weight");
  requireNonNegative(preferences.capacityWeight, "Scheduler capacity weight");
  const total = preferences.costWeight
    + preferences.reliabilityWeight
    + preferences.capacityWeight;
  if (total <= 0) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "At least one scheduler simulation weight must be positive"
    );
  }
}

function summarizeHistory(input: {
  portfolioId: string;
  companyId: string;
  placements: readonly HistoricalPlacementObservation[];
  aiGateway: readonly HistoricalAiGatewayObservation[];
}): HistoricalSimulationSummary {
  const placements = input.placements.filter((item) =>
    item.portfolioId === input.portfolioId
    && item.companyId === input.companyId
  );
  const aiGateway = input.aiGateway.filter((item) =>
    item.portfolioId === input.portfolioId
    && item.companyId === input.companyId
  );

  for (const item of placements) {
    if (item.label !== "historical-observation") {
      throw new ControlPlaneError("VALIDATION_FAILED", "Placement history must be explicitly labeled");
    }
    requireNonNegative(item.costCents, "Historical placement cost");
    requireNonNegative(item.utilizationPct, "Historical utilization");
    requireNonNegative(item.queueMs, "Historical queue time");
  }
  for (const item of aiGateway) {
    if (item.label !== "historical-observation") {
      throw new ControlPlaneError("VALIDATION_FAILED", "AI gateway history must be explicitly labeled");
    }
    requireNonNegative(item.costCents, "Historical AI gateway cost");
    requireNonNegative(item.latencyMs, "Historical AI gateway latency");
  }

  return Object.freeze({
    label: "historical-summary" as const,
    placementSampleSize: placements.length,
    aiGatewaySampleSize: aiGateway.length,
    averagePlacementCostCents: average(placements.map((item) => item.costCents)),
    averageUtilizationPct: average(placements.map((item) => item.utilizationPct)),
    averageQueueMs: average(placements.map((item) => item.queueMs)),
    placementFailureRatePct: percentage(
      placements.filter((item) => item.failed).length,
      placements.length
    ),
    verifiedOutcomeRatePct: percentage(
      placements.filter((item) => item.verifiedOutcome).length,
      placements.length
    ),
    averageAiGatewayCostCents: average(aiGateway.map((item) => item.costCents)),
    averageAiGatewayLatencyMs: average(aiGateway.map((item) => item.latencyMs)),
    aiGatewaySuccessRatePct: percentage(
      aiGateway.filter((item) => item.success).length,
      aiGateway.length
    )
  });
}

function calculateUncertainty(
  historical: HistoricalSimulationSummary,
  economicCandidateCount: number,
  placementEligibleCount: number
): SimulationUncertainty {
  const reasons: string[] = [];
  let level: SimulationUncertainty["level"] = "low";

  if (historical.placementSampleSize < 5) {
    level = "high";
    reasons.push("limited-placement-history");
  } else if (historical.placementSampleSize < 20) {
    level = "medium";
    reasons.push("moderate-placement-history");
  }

  if (historical.aiGatewaySampleSize < 5) {
    reasons.push("limited-ai-gateway-history");
    if (level === "low") level = "medium";
  }
  if (economicCandidateCount < placementEligibleCount) {
    reasons.push("missing-economic-snapshots");
    level = "high";
  }
  if (placementEligibleCount === 0) {
    reasons.push("no-policy-eligible-candidates");
    level = "high";
  }

  return Object.freeze({
    level,
    reasons: Object.freeze(reasons),
    placementSampleSize: historical.placementSampleSize,
    aiGatewaySampleSize: historical.aiGatewaySampleSize
  });
}

export function simulateResourcePolicy(input: {
  id: string;
  portfolioId: string;
  companyId: string;
  request: PlacementRequestRecord;
  candidates: readonly PlacementCandidateSnapshot[];
  economicCandidates: readonly CostGovernorCandidate[];
  proposal: ResourcePolicySimulationProposal;
  historicalPlacements: readonly HistoricalPlacementObservation[];
  historicalAiGateway: readonly HistoricalAiGatewayObservation[];
  assumptions?: readonly string[];
  now?: number;
}): ResourcePolicySimulationResult {
  const now = input.now ?? Date.now();
  validateSchedulerPreferences(input.proposal.scheduler);

  if (
    input.request.portfolioId !== input.portfolioId
    || input.request.companyId !== input.companyId
    || input.proposal.budget.portfolioId !== input.portfolioId
    || input.proposal.budget.companyId !== input.companyId
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Simulation inputs are outside authoritative scope");
  }
  if (
    input.proposal.source === "ai-recommendation"
    && !input.proposal.modelEvidence
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "AI recommendation simulations must record AI Gateway model evidence"
    );
  }
  if (
    input.proposal.modelEvidence
    && input.proposal.modelEvidence.source !== "ai-gateway"
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Simulation model evidence must come through the AI Gateway");
  }

  const placementReport = evaluatePlacementCandidates({
    request: input.request,
    candidates: input.candidates,
    policy: input.proposal.policy,
    now
  });

  const governorReport = evaluateCostCapacityGovernor({
    placementReport,
    portfolioId: input.portfolioId,
    companyId: input.companyId,
    jobId: input.request.jobId,
    candidates: input.economicCandidates,
    budget: input.proposal.budget,
    now
  });

  const historical = summarizeHistory({
    portfolioId: input.portfolioId,
    companyId: input.companyId,
    placements: input.historicalPlacements,
    aiGateway: input.historicalAiGateway
  });

  const candidateById = new Map(
    input.candidates.map((candidate) => [candidate.resourceId, candidate])
  );
  const governorById = new Map(
    governorReport.candidates.map((candidate) => [candidate.resourceId, candidate])
  );

  const schedulableIds = [
    ...governorReport.rankedAllowedCandidateIds,
    ...governorReport.approvalRequiredCandidateIds
  ];
  const maxCost = Math.max(
    1,
    ...schedulableIds.map((id) => governorById.get(id)?.estimatedJobCostCents ?? 0)
  );
  const maxCpu = Math.max(
    1,
    ...schedulableIds.map((id) => candidateById.get(id)?.availableCapacity.cpuCores ?? 0)
  );
  const weightTotal = input.proposal.scheduler.costWeight
    + input.proposal.scheduler.reliabilityWeight
    + input.proposal.scheduler.capacityWeight;

  const simulatedSchedulerOrder = schedulableIds
    .map((resourceId): SimulatedSchedulerCandidate => {
      const candidate = candidateById.get(resourceId);
      const economics = governorById.get(resourceId);
      if (!candidate || !economics || economics.disposition === "blocked") {
        throw new ControlPlaneError("INTERNAL", "Simulator candidate lineage is incomplete");
      }
      const costScore = 1 - economics.estimatedJobCostCents / maxCost;
      const reliabilityScore = reliabilityValue(candidate.reliabilityTier) / 100;
      const capacityScore = candidate.availableCapacity.cpuCores / maxCpu;
      const preferredRegion = Boolean(
        input.proposal.scheduler.preferredRegions?.includes(candidate.region ?? "")
      );
      const weighted = (
        costScore * input.proposal.scheduler.costWeight
        + reliabilityScore * input.proposal.scheduler.reliabilityWeight
        + capacityScore * input.proposal.scheduler.capacityWeight
      ) / weightTotal;
      const score = Number((weighted + (preferredRegion ? 0.01 : 0)).toFixed(6));

      return Object.freeze({
        resourceId,
        score,
        disposition: economics.disposition as "allow" | "approval-required",
        estimatedJobCostCents: economics.estimatedJobCostCents,
        reliabilityTier: candidate.reliabilityTier,
        availableCpuCores: candidate.availableCapacity.cpuCores,
        preferredRegion
      });
    })
    .sort((left, right) =>
      (left.disposition === right.disposition
        ? 0
        : left.disposition === "allow" ? -1 : 1)
      || right.score - left.score
      || left.resourceId.localeCompare(right.resourceId)
    );

  const placementEligibleIds = new Set(placementReport.eligibleCandidateIds);
  const placementEligibleCandidates = input.candidates.filter((candidate) =>
    placementEligibleIds.has(candidate.resourceId)
  );
  const eligibleCapacityCpuCores = placementEligibleCandidates.reduce(
    (sum, candidate) => sum + candidate.availableCapacity.cpuCores,
    0
  );
  const policyRejectedCandidateCount = placementReport.candidates.filter((candidate) =>
    candidate.rejectionReasons.some((reason) => reason.startsWith("policy:"))
  ).length;

  const historicalReliability = historical.placementFailureRatePct === undefined
    ? undefined
    : Number((100 - historical.placementFailureRatePct).toFixed(4));
  const tierReliability = average(
    placementEligibleCandidates.map((candidate) => reliabilityValue(candidate.reliabilityTier))
  );
  const expectedReliabilityPct = historicalReliability ?? tierReliability;
  const projectedFailureRatePct = expectedReliabilityPct === undefined
    ? undefined
    : Number((100 - expectedReliabilityPct).toFixed(4));

  const expectedCostCents = simulatedSchedulerOrder[0]?.estimatedJobCostCents;

  const guardrailFindings: SimulationGuardrailFinding[] = [];
  const guardrails = input.proposal.guardrails;
  if (guardrails.minimumEligibleCandidates !== undefined) {
    requireNonNegative(guardrails.minimumEligibleCandidates, "Minimum eligible candidates");
    guardrailFindings.push(Object.freeze({
      guardrail: "minimum-eligible-candidates",
      satisfied: placementReport.eligibleCandidateIds.length >= guardrails.minimumEligibleCandidates,
      observed: placementReport.eligibleCandidateIds.length,
      required: guardrails.minimumEligibleCandidates
    }));
  }
  if (guardrails.maximumProjectedFailureRatePct !== undefined) {
    requireNonNegative(
      guardrails.maximumProjectedFailureRatePct,
      "Maximum projected failure rate"
    );
    guardrailFindings.push(Object.freeze({
      guardrail: "maximum-projected-failure-rate",
      satisfied: projectedFailureRatePct !== undefined
        && projectedFailureRatePct <= guardrails.maximumProjectedFailureRatePct,
      observed: projectedFailureRatePct,
      required: guardrails.maximumProjectedFailureRatePct
    }));
  }
  if (guardrails.minimumEligibleCpuCores !== undefined) {
    requireNonNegative(guardrails.minimumEligibleCpuCores, "Minimum eligible CPU cores");
    guardrailFindings.push(Object.freeze({
      guardrail: "minimum-eligible-cpu-cores",
      satisfied: eligibleCapacityCpuCores >= guardrails.minimumEligibleCpuCores,
      observed: eligibleCapacityCpuCores,
      required: guardrails.minimumEligibleCpuCores
    }));
  }
  if (guardrails.maximumExpectedCostCents !== undefined) {
    requireNonNegative(guardrails.maximumExpectedCostCents, "Maximum expected cost");
    guardrailFindings.push(Object.freeze({
      guardrail: "maximum-expected-cost",
      satisfied: expectedCostCents !== undefined
        && expectedCostCents <= guardrails.maximumExpectedCostCents,
      observed: expectedCostCents,
      required: guardrails.maximumExpectedCostCents
    }));
  }

  const assumptions = [
    ...(input.assumptions ?? []),
    "simulation-does-not-reserve-or-dispatch",
    historicalReliability === undefined
      ? "reliability-projection-uses-resource-tier-because-history-is-insufficient"
      : "reliability-projection-uses-observed-historical-failure-rate",
    "scheduler-order-is-simulated-only-and-has-no-placement-authority"
  ];

  const projection: SimulationProjection = Object.freeze({
    label: "simulation-projection" as const,
    expectedCostCents,
    expectedReliabilityPct,
    projectedFailureRatePct,
    eligibleCapacityCpuCores,
    placementEligibleCandidateCount: placementReport.eligibleCandidateIds.length,
    economicallyAllowedCandidateCount: governorReport.rankedAllowedCandidateIds.length,
    approvalRequiredCandidateCount: governorReport.approvalRequiredCandidateIds.length,
    policyRejectedCandidateCount,
    simulatedSchedulerOrder: Object.freeze(simulatedSchedulerOrder),
    guardrailFindings: Object.freeze(guardrailFindings)
  });

  const uncertainty = calculateUncertainty(
    historical,
    input.economicCandidates.length,
    placementReport.eligibleCandidateIds.length
  );

  const base: Omit<ResourcePolicySimulationResult, "simulationHash"> = {
    id: input.id,
    portfolioId: input.portfolioId,
    companyId: input.companyId,
    placementRequestId: input.request.id,
    proposalSource: input.proposal.source,
    modelEvidence: input.proposal.modelEvidence
      ? Object.freeze({ ...input.proposal.modelEvidence })
      : undefined,
    historical,
    projection,
    assumptions: Object.freeze(assumptions),
    uncertainty,
    policyMutationApplied: false,
    reservationAttempted: false,
    dispatchAttempted: false,
    secretLookupAttempted: false,
    automaticPolicyPromotion: false,
    sideEffects: Object.freeze([])
  };
  return Object.freeze({ ...base, simulationHash: sha256Hex(base) });
}
