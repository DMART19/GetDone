import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  isResourceSignalType,
  type AttentionAction,
  type NormalizedSignal,
  type ResourceSignalType,
  type SensedSignal,
  type SignalClass
} from "@/lib/intelligence/signals";
import type { InvestigationCoordinator, InvestigationResult } from "@/lib/intelligence/investigations";

export type BaselineDirection = "increase-is-bad" | "decrease-is-bad" | "either";

export interface SensingProfile {
  id: string;
  portfolioId: string;
  companyId: string;
  resourceId?: string;
  signalType: string;
  metric?: string;
  baselineValue?: number;
  direction: BaselineDirection;
  monitorDeviationRatio: number;
  investigateDeviationRatio: number;
  escalateDeviationRatio: number;
  windowSeconds: number;
  minimumSamples: number;
  sustainedSeconds: number;
  maxAgeSeconds: number;
  cooldownSeconds: number;
}

export interface SensingProfileStore {
  listForCompany(input: {
    portfolioId: string;
    companyId: string;
  }): Promise<readonly SensingProfile[]>;
}

export interface SensingProfileResolver {
  resolve(signal: NormalizedSignal): Promise<SensingProfile | null>;
}

export class ScopedSensingProfileResolver implements SensingProfileResolver {
  constructor(private readonly store: SensingProfileStore) {}

  async resolve(signal: NormalizedSignal) {
    const profiles = await this.store.listForCompany({
      portfolioId: signal.scope.portfolioId,
      companyId: signal.scope.companyId
    });

    const matching = profiles
      .filter((profile) => profile.portfolioId === signal.scope.portfolioId)
      .filter((profile) => profile.companyId === signal.scope.companyId)
      .filter((profile) => profile.signalType === signal.type)
      .filter((profile) => !profile.metric || profile.metric === signal.metric)
      .filter((profile) => !profile.resourceId || profile.resourceId === signal.scope.resourceId)
      .map(validateSensingProfile);

    if (signal.scope.resourceId) {
      const resourceSpecific = matching.find((profile) => profile.resourceId === signal.scope.resourceId);
      if (resourceSpecific) return resourceSpecific;
    }

    return matching.find((profile) => !profile.resourceId) ?? null;
  }
}

export interface RecentSignalReader {
  listRecent(input: {
    portfolioId: string;
    companyId: string;
    resourceId?: string;
    signalType: string;
    since: string;
  }): Promise<readonly NormalizedSignal[]>;
}

export interface SensingResult {
  sensed: SensedSignal;
  investigation: InvestigationResult;
}

const resourceAttention: Record<ResourceSignalType, {
  classification: SignalClass;
  action: AttentionAction;
  rationale: string;
}> = {
  "resource.added": { classification: "informational", action: "RECORD", rationale: "Resource addition recorded" },
  "resource.ready": { classification: "informational", action: "RECORD", rationale: "Resource readiness recorded" },
  "resource.offline": { classification: "incident", action: "ESCALATE", rationale: "Resource is offline" },
  "resource.degraded": { classification: "risk", action: "INVESTIGATE", rationale: "Resource health is degraded" },
  "resource.saturated": { classification: "threshold", action: "INVESTIGATE", rationale: "Resource is saturated" },
  "resource.capacity-low": { classification: "threshold", action: "MONITOR", rationale: "Available capacity is low" },
  "resource.cost-spike": { classification: "anomaly", action: "INVESTIGATE", rationale: "Resource cost spike detected" },
  "resource.failover": { classification: "incident", action: "ESCALATE", rationale: "Resource failover signal received" },
  "resource.credential-failure": { classification: "incident", action: "ESCALATE", rationale: "Resource credential failure detected" },
  "resource.policy-violation": { classification: "incident", action: "ESCALATE", rationale: "Resource policy violation detected" },
  "resource.drain-started": { classification: "expected", action: "RECORD", rationale: "Resource drain started" },
  "resource.drain-complete": { classification: "expected", action: "RECORD", rationale: "Resource drain completed" }
};

export function validateSensingProfile(profile: SensingProfile) {
  const thresholds = [
    profile.monitorDeviationRatio,
    profile.investigateDeviationRatio,
    profile.escalateDeviationRatio
  ];

  if (thresholds.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Sensing thresholds must be non-negative finite ratios");
  }

  if (!(thresholds[0] <= thresholds[1] && thresholds[1] <= thresholds[2])) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Sensing thresholds must be monotonic");
  }

  const durations = [
    profile.windowSeconds,
    profile.minimumSamples,
    profile.sustainedSeconds,
    profile.maxAgeSeconds,
    profile.cooldownSeconds
  ];
  if (durations.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Sensing window values must be non-negative integers");
  }

  if (profile.windowSeconds === 0 || profile.minimumSamples === 0 || profile.maxAgeSeconds === 0) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Sensing window, minimum samples, and freshness limit must be greater than zero"
    );
  }

  if (profile.sustainedSeconds > profile.windowSeconds) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Sustained duration cannot exceed the sensing window"
    );
  }

  if (!profile.id || !profile.portfolioId || !profile.companyId || !profile.signalType) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Sensing profile must be scoped and named");
  }

  return profile;
}

function ageSeconds(signal: NormalizedSignal, now: number) {
  return (now - Date.parse(signal.occurredAt)) / 1000;
}

function directionalDeviation(value: number, baseline: number, direction: BaselineDirection) {
  const denominator = Math.max(Math.abs(baseline), 0.0001);
  if (direction === "increase-is-bad") return Math.max(0, value - baseline) / denominator;
  if (direction === "decrease-is-bad") return Math.max(0, baseline - value) / denominator;
  return Math.abs(value - baseline) / denominator;
}

function numericDecision(
  signal: NormalizedSignal,
  profile: SensingProfile,
  recent: readonly NormalizedSignal[]
): { classification: SignalClass; action: AttentionAction; rationale: string[] } | null {
  if (typeof signal.value !== "number" || typeof profile.baselineValue !== "number") return null;

  const deviation = directionalDeviation(signal.value, profile.baselineValue, profile.direction);
  const signalTime = Date.parse(signal.occurredAt);
  const sameScope = (candidate: NormalizedSignal) =>
    candidate.scope.portfolioId === signal.scope.portfolioId
    && candidate.scope.companyId === signal.scope.companyId
    && candidate.scope.resourceId === signal.scope.resourceId;

  const windowSamples = recent
    .filter((candidate) => sameScope(candidate))
    .filter((candidate) => candidate.type === signal.type)
    .filter((candidate) => !profile.metric || candidate.metric === profile.metric)
    .filter((candidate) => typeof candidate.value === "number")
    .filter((candidate) => {
      const occurredAt = Date.parse(candidate.occurredAt);
      return Number.isFinite(occurredAt)
        && occurredAt <= signalTime
        && occurredAt >= signalTime - profile.windowSeconds * 1000;
    });

  const thresholdConsistentSamples = windowSamples.filter((candidate) =>
    directionalDeviation(candidate.value as number, profile.baselineValue as number, profile.direction)
      >= profile.investigateDeviationRatio
  );

  const sustained = thresholdConsistentSamples.length + 1 >= profile.minimumSamples
    && (signal.sustainedForSeconds ?? 0) >= profile.sustainedSeconds;

  if (deviation >= profile.escalateDeviationRatio && sustained) {
    return {
      classification: "anomaly",
      action: "ESCALATE",
      rationale: [`Deviation ${deviation.toFixed(3)} exceeded escalation threshold`, "Threshold was sustained"]
    };
  }

  if (deviation >= profile.investigateDeviationRatio && sustained) {
    return {
      classification: "anomaly",
      action: "INVESTIGATE",
      rationale: [`Deviation ${deviation.toFixed(3)} exceeded investigation threshold`, "Threshold was sustained"]
    };
  }

  if (deviation >= profile.monitorDeviationRatio) {
    return {
      classification: "threshold",
      action: "MONITOR",
      rationale: [`Deviation ${deviation.toFixed(3)} exceeded monitoring threshold`]
    };
  }

  return {
    classification: "informational",
    action: "IGNORE",
    rationale: ["Observed value remained inside configured deterministic thresholds"]
  };
}

export function evaluateSignal(
  signal: NormalizedSignal,
  profile: SensingProfile | null,
  recent: readonly NormalizedSignal[],
  now = Date.now()
): SensedSignal {
  if (profile) validateSensingProfile(profile);

  if (profile && ageSeconds(signal, now) > profile.maxAgeSeconds) {
    return {
      ...signal,
      classification: "informational",
      action: "RECORD",
      sensingProfileId: profile.id,
      rationale: ["Signal is stale; recorded without opening investigation"]
    };
  }

  if (isResourceSignalType(signal.type)) {
    const rule = resourceAttention[signal.type];
    return {
      ...signal,
      classification: rule.classification,
      action: rule.action,
      sensingProfileId: profile?.id,
      rationale: [rule.rationale]
    };
  }

  if (signal.severity === "critical") {
    return { ...signal, classification: "incident", action: "ESCALATE", sensingProfileId: profile?.id, rationale: ["Critical source severity"] };
  }

  if (signal.severity === "high") {
    return { ...signal, classification: "risk", action: "INVESTIGATE", sensingProfileId: profile?.id, rationale: ["High source severity"] };
  }

  if (signal.expected) {
    return { ...signal, classification: "expected", action: "RECORD", sensingProfileId: profile?.id, rationale: ["Signal is marked expected after hard incident checks"] };
  }

  if (profile) {
    const numeric = numericDecision(signal, profile, recent);
    if (numeric) {
      return { ...signal, ...numeric, sensingProfileId: profile.id };
    }
  }

  if (signal.severity === "medium") {
    return { ...signal, classification: "threshold", action: "MONITOR", sensingProfileId: profile?.id, rationale: ["Medium severity signal"] };
  }

  if (signal.severity === "low") {
    return { ...signal, classification: "informational", action: "RECORD", sensingProfileId: profile?.id, rationale: ["Low severity signal"] };
  }

  return { ...signal, classification: "informational", action: "IGNORE", sensingProfileId: profile?.id, rationale: ["No deterministic attention rule matched"] };
}

export class SensingEngine {
  constructor(
    private readonly profiles: SensingProfileResolver,
    private readonly recentSignals: RecentSignalReader,
    private readonly investigations: InvestigationCoordinator
  ) {}

  async process(signal: NormalizedSignal, now = new Date()): Promise<SensingResult> {
    const profile = await this.profiles.resolve(signal);
    if (profile) validateSensingProfile(profile);

    const recent = profile
      ? await this.recentSignals.listRecent({
          portfolioId: signal.scope.portfolioId,
          companyId: signal.scope.companyId,
          resourceId: signal.scope.resourceId,
          signalType: signal.type,
          since: new Date(now.getTime() - profile.windowSeconds * 1000).toISOString()
        })
      : [];

    const sensed = evaluateSignal(signal, profile, recent, now.getTime());
    const investigation = await this.investigations.consider(
      sensed,
      { cooldownSeconds: profile?.cooldownSeconds ?? 900 },
      now
    );

    return { sensed, investigation };
  }
}
