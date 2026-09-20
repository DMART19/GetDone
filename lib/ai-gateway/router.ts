import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { blockingKillSwitches, type KillSwitch } from "@/lib/domain/kill-switch";
import type {
  AIRequestEnvelope,
  AIRouteDecision,
  ModelEligibilityResult,
  ModelProfile,
  ModelRoutePolicy
} from "@/lib/ai-gateway/contracts";

const latencyRank = { low: 0, standard: 1, high: 2 } as const;

function requireNonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be non-negative`);
  }
}

function estimateCostCents(profile: ModelProfile, request: AIRequestEnvelope) {
  const input = request.requirements.estimatedInputTokens / 1_000_000
    * profile.inputCostPerMillionTokensCents;
  const output = request.requirements.expectedOutputTokens / 1_000_000
    * profile.outputCostPerMillionTokensCents;
  return Number((input + output).toFixed(6));
}

export function evaluateModelEligibility(
  profile: ModelProfile,
  request: AIRequestEnvelope,
  killSwitches: readonly KillSwitch[] = []
): ModelEligibilityResult {
  const reasons: string[] = [];
  const req = request.requirements;

  requireNonNegative(req.minimumContextTokens, "minimumContextTokens");
  requireNonNegative(req.estimatedInputTokens, "estimatedInputTokens");
  requireNonNegative(req.expectedOutputTokens, "expectedOutputTokens");
  requireNonNegative(req.maxCostCents, "maxCostCents");

  if (req.role === "DETERMINISTIC") reasons.push("deterministic-role-does-not-call-model");
  if (!profile.enabled) reasons.push("profile-disabled");
  if (profile.validationStatus !== "validated") reasons.push("profile-not-validated");
  if (profile.health !== "healthy") reasons.push("profile-not-healthy");
  if (req.role !== "DETERMINISTIC" && !profile.roles.includes(req.role)) reasons.push("role-not-supported");
  for (const modality of req.requiredModalities) {
    if (!profile.modalities.includes(modality)) reasons.push(`modality-not-supported:${modality}`);
  }
  if (req.requiresTools && !profile.supportsTools) reasons.push("tools-not-supported");
  if (req.requiresStructuredOutput && !profile.supportsStructuredOutput) {
    reasons.push("structured-output-not-supported");
  }
  if (profile.maxContextTokens < req.minimumContextTokens) reasons.push("context-window-too-small");
  if (!profile.allowedDataClasses.includes(req.dataClass)) reasons.push("data-class-not-allowed");
  if (!profile.allowedEnvironments.includes(req.environment)) reasons.push("environment-not-allowed");
  if (latencyRank[profile.latencyClass] > latencyRank[req.latencyClass]) reasons.push("latency-class-too-slow");
  if (req.excludedProfileIds?.includes(profile.id)) reasons.push("profile-excluded");
  if (req.pinnedProfileIds && !req.pinnedProfileIds.includes(profile.id)) reasons.push("profile-not-pinned");

  const estimatedCostCents = estimateCostCents(profile, request);
  if (estimatedCostCents > req.maxCostCents) reasons.push("estimated-cost-exceeds-ceiling");

  const blocked = blockingKillSwitches(killSwitches, {
    portfolioId: request.scope.portfolioId,
    companyId: request.scope.companyId,
    providerId: profile.providerId,
    workloadClass: `ai:${req.role}`
  });
  if (blocked.length > 0) reasons.push(...blocked.map((item) => `kill-switch:${item.id}`));

  return Object.freeze({
    profileId: profile.id,
    eligible: reasons.length === 0,
    rejectionReasons: Object.freeze(reasons.sort()),
    estimatedCostCents
  });
}

export function routeAIRequest(input: {
  request: AIRequestEnvelope;
  profiles: readonly ModelProfile[];
  policy: ModelRoutePolicy;
  killSwitches?: readonly KillSwitch[];
  decidedAt: string;
}): AIRouteDecision {
  const decidedAt = Date.parse(input.decidedAt);
  if (!Number.isFinite(decidedAt)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "AI route decision time is invalid");
  }

  if (input.request.requirements.role === "DETERMINISTIC") {
    const base = {
      requestId: input.request.id,
      routingPolicyVersion: input.policy.version,
      kind: "deterministic" as const,
      fallbackProfileIds: Object.freeze([]) as readonly string[],
      eligibleProfileIds: Object.freeze([]) as readonly string[],
      rejected: Object.freeze({}) as Readonly<Record<string, readonly string[]>>,
      decidedAt: new Date(decidedAt).toISOString()
    };
    return Object.freeze({ ...base, decisionHash: sha256Hex(base) });
  }

  const configuredIds = input.policy.routes[input.request.requirements.role] ?? [];
  const byId = new Map(input.profiles.map((profile) => [profile.id, profile]));
  const evaluations = new Map<string, ModelEligibilityResult>();
  const rejected: Record<string, readonly string[]> = {};
  const eligible: string[] = [];

  for (const profileId of configuredIds) {
    const profile = byId.get(profileId);
    if (!profile) {
      rejected[profileId] = Object.freeze(["profile-not-found"]);
      continue;
    }
    const result = evaluateModelEligibility(profile, input.request, input.killSwitches ?? []);
    evaluations.set(profileId, result);
    if (result.eligible) eligible.push(profileId);
    else rejected[profileId] = result.rejectionReasons;
  }

  const selectedProfileId = eligible[0];
  const fallbackProfileIds = selectedProfileId && input.request.requirements.allowFallback
    ? eligible.slice(1)
    : [];

  const kind = selectedProfileId ? "model" as const : "no-eligible-model" as const;
  const base = {
    requestId: input.request.id,
    routingPolicyVersion: input.policy.version,
    kind,
    selectedProfileId,
    fallbackProfileIds: Object.freeze(fallbackProfileIds),
    eligibleProfileIds: Object.freeze(eligible),
    rejected: Object.freeze(rejected),
    decidedAt: new Date(decidedAt).toISOString()
  };
  return Object.freeze({ ...base, decisionHash: sha256Hex(base) });
}

export function assertRouteDecisionIntegrity(decision: AIRouteDecision) {
  const { decisionHash, ...base } = decision;
  if (sha256Hex(base) !== decisionHash) {
    throw new ControlPlaneError("FORBIDDEN", "AI route decision integrity check failed");
  }
  return decision;
}
