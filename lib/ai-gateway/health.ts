import type {
  AIBudgetSnapshot,
  ModelProfile,
  ModelRoutePolicy
} from "@/lib/ai-gateway/contracts";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export type AIGatewayAvailability = "available" | "unavailable" | "not-configured";
export type AIGatewayBudgetState =
  | "healthy"
  | "exhausted"
  | "saturated"
  | "stale"
  | "unavailable";

export interface AIGatewayHealthEvidence {
  lastSuccessfulCanaryAt: string | null;
  recentErrorClass: string | null;
  budget: {
    state: AIGatewayBudgetState;
    period: string | null;
    companyRemainingCents: number | null;
    portfolioRemainingCents: number | null;
    activeConcurrentCalls: number | null;
    concurrencyLimit: number | null;
    snapshotAt: string | null;
    expiresAt: string | null;
  };
}

export interface AIGatewayHealthEvidenceReader {
  read(
    scope: TrustedExecutionScope,
    environment: TrustedExecutionScope["environment"],
    now?: Date
  ): Promise<AIGatewayHealthEvidence>;
}

export interface OwnerSafeAIGatewayHealth {
  configured: boolean;
  routingPolicyVersion: string | null;
  lastSuccessfulCanaryAt: string | null;
  primaryAvailability: AIGatewayAvailability;
  fallbackAvailability: AIGatewayAvailability;
  recentErrorClass: string | null;
  budget: AIGatewayHealthEvidence["budget"];
  checkedAt: string;
}

function profileAvailable(
  profile: ModelProfile | undefined,
  environment: TrustedExecutionScope["environment"]
) {
  return Boolean(
    profile
    && profile.enabled
    && profile.validationStatus === "validated"
    && profile.health === "healthy"
    && profile.allowedEnvironments.includes(environment)
  );
}

function availability(
  configuredProfileId: string | undefined,
  byId: ReadonlyMap<string, ModelProfile>,
  environment: TrustedExecutionScope["environment"]
): AIGatewayAvailability {
  if (!configuredProfileId) return "not-configured";
  return profileAvailable(byId.get(configuredProfileId), environment)
    ? "available"
    : "unavailable";
}

function safeErrorClass(value: string | null) {
  if (!value) return null;
  return /^[A-Z0-9_.:-]{1,80}$/.test(value) ? value : "UNKNOWN";
}

export function buildOwnerSafeAIGatewayHealth(input: {
  env?: Readonly<Record<string, string | undefined>>;
  environment: TrustedExecutionScope["environment"];
  evidence: AIGatewayHealthEvidence;
  checkedAt?: Date;
}): OwnerSafeAIGatewayHealth {
  const env = input.env ?? process.env;
  const checkedAt = input.checkedAt ?? new Date();

  const configured = Boolean(
    env.OPENROUTER_API_KEY?.trim()
    && env.GETDONE_AI_MODEL_PROFILES_JSON?.trim()
    && env.GETDONE_AI_ROUTING_POLICY_JSON?.trim()
  );
  if (!configured) {
    return Object.freeze({
      configured: false,
      routingPolicyVersion: null,
      lastSuccessfulCanaryAt: input.evidence.lastSuccessfulCanaryAt,
      primaryAvailability: "not-configured",
      fallbackAvailability: "not-configured",
      recentErrorClass: safeErrorClass(input.evidence.recentErrorClass),
      budget: input.evidence.budget,
      checkedAt: checkedAt.toISOString()
    });
  }

  let profiles: readonly ModelProfile[];
  let policy: ModelRoutePolicy;
  try {
    const rawProfiles = JSON.parse(env.GETDONE_AI_MODEL_PROFILES_JSON!);
    const rawPolicy = JSON.parse(env.GETDONE_AI_ROUTING_POLICY_JSON!);
    if (
      !Array.isArray(rawProfiles)
      || rawProfiles.length === 0
      || rawProfiles.some((profile) =>
        !profile
        || typeof profile !== "object"
        || typeof profile.id !== "string"
        || typeof profile.enabled !== "boolean"
        || !["validated", "unvalidated", "failed"].includes(profile.validationStatus)
        || !["healthy", "degraded", "disabled"].includes(profile.health)
        || !Array.isArray(profile.allowedEnvironments)
      )
      || !rawPolicy
      || typeof rawPolicy !== "object"
      || typeof rawPolicy.version !== "string"
      || !rawPolicy.routes
      || typeof rawPolicy.routes !== "object"
      || Object.values(rawPolicy.routes).some((route) =>
        !Array.isArray(route) || route.some((value) => typeof value !== "string")
      )
    ) {
      throw new Error("invalid AI health configuration");
    }
    profiles = rawProfiles as ModelProfile[];
    policy = rawPolicy as ModelRoutePolicy;
  } catch {
    return Object.freeze({
      configured: false,
      routingPolicyVersion: null,
      lastSuccessfulCanaryAt: input.evidence.lastSuccessfulCanaryAt,
      primaryAvailability: "unavailable",
      fallbackAvailability: "unavailable",
      recentErrorClass: "CONFIGURATION_INVALID",
      budget: input.evidence.budget,
      checkedAt: checkedAt.toISOString()
    });
  }

  const standardRoute = policy.routes.STANDARD ?? [];
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));

  return Object.freeze({
    configured: true,
    routingPolicyVersion: policy.version,
    lastSuccessfulCanaryAt: input.evidence.lastSuccessfulCanaryAt,
    primaryAvailability: availability(standardRoute[0], byId, input.environment),
    fallbackAvailability: availability(standardRoute[1], byId, input.environment),
    recentErrorClass: safeErrorClass(input.evidence.recentErrorClass),
    budget: input.evidence.budget,
    checkedAt: checkedAt.toISOString()
  });
}

export function budgetEvidenceFromSnapshot(
  snapshot: AIBudgetSnapshot | null,
  now = new Date()
): AIGatewayHealthEvidence["budget"] {
  if (!snapshot) {
    return {
      state: "unavailable",
      period: null,
      companyRemainingCents: null,
      portfolioRemainingCents: null,
      activeConcurrentCalls: null,
      concurrencyLimit: null,
      snapshotAt: null,
      expiresAt: null
    };
  }

  const expired = Date.parse(snapshot.expiresAt) <= now.getTime();
  const exhausted = snapshot.companyRemainingCents <= 0
    || snapshot.portfolioRemainingCents <= 0;
  const saturated = snapshot.activeConcurrentCalls >= snapshot.concurrencyLimit;

  return {
    state: expired
      ? "stale"
      : exhausted
        ? "exhausted"
        : saturated
          ? "saturated"
          : "healthy",
    period: snapshot.period,
    companyRemainingCents: snapshot.companyRemainingCents,
    portfolioRemainingCents: snapshot.portfolioRemainingCents,
    activeConcurrentCalls: snapshot.activeConcurrentCalls,
    concurrencyLimit: snapshot.concurrencyLimit,
    snapshotAt: snapshot.snapshotAt,
    expiresAt: snapshot.expiresAt
  };
}
