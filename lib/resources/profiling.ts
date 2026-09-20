import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { ResourceHealthStatus } from "@/lib/domain/resources";

export interface ResourceProfileClaim {
  resourceId: string;
  portfolioId: string;
  companyId: string;
  architecture: string;
  cpuCores: number;
  memoryMb: number;
  gpu?: {
    model: string;
    count: number;
    vramMb: number;
  };
  diskGb: number;
  networkMbps: number;
  runtimeNames: readonly string[];
  supportedSoftware: readonly string[];
  claimedCapabilities: readonly string[];
  benchmarkScore?: number;
  latencyMs?: number;
  uptimeSeconds?: number;
  thermalCelsius?: number;
  powerWatts?: number;
  observedAt: string;
  source: "resource-agent" | "provider" | "manual";
}

export interface CapabilityValidationEvidence {
  id: string;
  resourceId: string;
  portfolioId: string;
  companyId: string;
  capability: string;
  validator: "control-plane-probe" | "trusted-provider" | "hardware-attestation";
  validated: boolean;
  observedAt: string;
  expiresAt: string;
  evidenceHash: string;
}

export interface ValidatedResourceProfile {
  id: string;
  resourceId: string;
  portfolioId: string;
  companyId: string;
  architecture: string;
  cpuCores: number;
  memoryMb: number;
  gpu?: ResourceProfileClaim["gpu"];
  diskGb: number;
  networkMbps: number;
  runtimeNames: readonly string[];
  supportedSoftware: readonly string[];
  validatedCapabilities: readonly string[];
  rejectedClaims: readonly { claim: string; reason: string }[];
  observedAt: string;
  expiresAt: string;
  profileHash: string;
}

export interface TelemetrySample {
  id: string;
  resourceId: string;
  portfolioId: string;
  companyId: string;
  authenticated: boolean;
  observedAt: string;
  cpuUtilizationPct: number;
  memoryUtilizationPct: number;
  diskUtilizationPct: number;
  gpuUtilizationPct?: number;
  thermalCelsius?: number;
  networkLatencyMs?: number;
  heartbeatOk: boolean;
}

export interface ResourceHealthSummary {
  resourceId: string;
  portfolioId: string;
  companyId: string;
  status: ResourceHealthStatus;
  observedAt: string;
  reasons: readonly string[];
  latestSampleId?: string;
  summaryHash: string;
}

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

function nonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be non-negative`);
  }
}

export function createCapabilityValidationEvidence(
  input: Omit<CapabilityValidationEvidence, "evidenceHash">
): CapabilityValidationEvidence {
  const observedAt = parseTime(input.observedAt, "Capability evidence observedAt");
  const expiresAt = parseTime(input.expiresAt, "Capability evidence expiresAt");
  if (expiresAt <= observedAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Capability evidence expiry must follow observation");
  }
  const base = { ...input };
  return Object.freeze({ ...base, evidenceHash: sha256Hex(base) });
}

function assertEvidenceIntegrity(evidence: CapabilityValidationEvidence) {
  const { evidenceHash, ...base } = evidence;
  if (sha256Hex(base) !== evidenceHash) {
    throw new ControlPlaneError("FORBIDDEN", "Capability evidence integrity check failed");
  }
}

export function validateResourceProfile(input: {
  id: string;
  claim: ResourceProfileClaim;
  evidence: readonly CapabilityValidationEvidence[];
  expiresAt: string;
  now?: number;
}): ValidatedResourceProfile {
  const now = input.now ?? Date.now();
  const observedAt = parseTime(input.claim.observedAt, "Resource profile observedAt");
  const expiresAt = parseTime(input.expiresAt, "Resource profile expiresAt");
  if (observedAt > now || expiresAt <= now || expiresAt <= observedAt) {
    throw new ControlPlaneError("FORBIDDEN", "Resource profile claim is stale, future-dated, or expired");
  }

  nonNegative(input.claim.cpuCores, "CPU cores");
  nonNegative(input.claim.memoryMb, "Memory");
  nonNegative(input.claim.diskGb, "Disk");
  nonNegative(input.claim.networkMbps, "Network");
  if (!input.claim.architecture || input.claim.cpuCores < 1 || input.claim.memoryMb < 128) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Resource profile lacks minimum usable compute identity");
  }

  const rejectedClaims: { claim: string; reason: string }[] = [];
  const validated = new Set<string>();

  for (const capability of [...new Set(input.claim.claimedCapabilities)].sort()) {
    const matches = input.evidence.filter((item) => {
      assertEvidenceIntegrity(item);
      return (
        item.resourceId === input.claim.resourceId
        && item.portfolioId === input.claim.portfolioId
        && item.companyId === input.claim.companyId
        && item.capability === capability
        && item.validated
        && Date.parse(item.observedAt) <= now
        && Date.parse(item.expiresAt) > now
      );
    });

    const privileged = capability.startsWith("gpu.")
      || capability.startsWith("production.")
      || capability.startsWith("storage.authoritative");

    if (privileged && matches.length === 0) {
      rejectedClaims.push({
        claim: capability,
        reason: "independent-validation-required"
      });
      continue;
    }
    validated.add(capability);
  }

  let gpu = input.claim.gpu;
  if (gpu) {
    nonNegative(gpu.count, "GPU count");
    nonNegative(gpu.vramMb, "GPU VRAM");
    const gpuEvidence = input.evidence.find((item) => {
      assertEvidenceIntegrity(item);
      return (
        item.resourceId === input.claim.resourceId
        && item.portfolioId === input.claim.portfolioId
        && item.companyId === input.claim.companyId
        && item.capability === "gpu.hardware"
        && item.validated
        && Date.parse(item.expiresAt) > now
      );
    });
    if (!gpuEvidence) {
      rejectedClaims.push({ claim: "gpu.hardware", reason: "independent-validation-required" });
      gpu = undefined;
    }
  }

  const base: Omit<ValidatedResourceProfile, "profileHash"> = {
    id: input.id,
    resourceId: input.claim.resourceId,
    portfolioId: input.claim.portfolioId,
    companyId: input.claim.companyId,
    architecture: input.claim.architecture,
    cpuCores: input.claim.cpuCores,
    memoryMb: input.claim.memoryMb,
    gpu,
    diskGb: input.claim.diskGb,
    networkMbps: input.claim.networkMbps,
    runtimeNames: Object.freeze([...new Set(input.claim.runtimeNames)].sort()),
    supportedSoftware: Object.freeze([...new Set(input.claim.supportedSoftware)].sort()),
    validatedCapabilities: Object.freeze([...validated].sort()),
    rejectedClaims: Object.freeze(rejectedClaims),
    observedAt: new Date(observedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString()
  };
  return Object.freeze({ ...base, profileHash: sha256Hex(base) });
}

export function summarizeResourceHealth(input: {
  resourceId: string;
  portfolioId: string;
  companyId: string;
  samples: readonly TelemetrySample[];
  now?: number;
  staleAfterSeconds?: number;
}): ResourceHealthSummary {
  const now = input.now ?? Date.now();
  const staleAfterSeconds = input.staleAfterSeconds ?? 120;
  const scoped = input.samples
    .filter((sample) =>
      sample.resourceId === input.resourceId
      && sample.portfolioId === input.portfolioId
      && sample.companyId === input.companyId
    )
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));

  if (scoped.some((sample) => !sample.authenticated)) {
    throw new ControlPlaneError("FORBIDDEN", "Unauthenticated telemetry cannot establish resource health");
  }

  const latest = scoped[0];
  const reasons: string[] = [];
  let status: ResourceHealthStatus = "unreachable";
  let observedAt = new Date(now).toISOString();

  if (!latest) {
    reasons.push("no-authenticated-telemetry");
  } else {
    const latestAt = parseTime(latest.observedAt, "Telemetry observedAt");
    observedAt = new Date(latestAt).toISOString();
    if (latestAt > now || now - latestAt > staleAfterSeconds * 1000 || !latest.heartbeatOk) {
      reasons.push("telemetry-stale-or-heartbeat-missing");
    } else if (
      latest.cpuUtilizationPct >= 95
      || latest.memoryUtilizationPct >= 95
      || latest.diskUtilizationPct >= 98
      || (latest.gpuUtilizationPct ?? 0) >= 98
      || (latest.thermalCelsius ?? 0) >= 90
    ) {
      status = "saturated";
      reasons.push("resource-capacity-or-thermal-saturation");
    } else if (
      latest.cpuUtilizationPct >= 80
      || latest.memoryUtilizationPct >= 85
      || latest.diskUtilizationPct >= 90
      || (latest.thermalCelsius ?? 0) >= 80
      || (latest.networkLatencyMs ?? 0) >= 500
    ) {
      status = "degraded";
      reasons.push("resource-health-degraded");
    } else {
      status = "healthy";
      reasons.push("authenticated-fresh-telemetry");
    }
  }

  const base: Omit<ResourceHealthSummary, "summaryHash"> = {
    resourceId: input.resourceId,
    portfolioId: input.portfolioId,
    companyId: input.companyId,
    status,
    observedAt,
    reasons: Object.freeze(reasons),
    latestSampleId: latest?.id
  };
  return Object.freeze({ ...base, summaryHash: sha256Hex(base) });
}

export type ResourceSimulationScenario =
  | "healthy"
  | "degraded"
  | "saturated"
  | "stale"
  | "heartbeat-lost";

export function simulateResourceTelemetry(input: {
  scenario: ResourceSimulationScenario;
  resourceId: string;
  portfolioId: string;
  companyId: string;
  at: string;
}): { samples: readonly TelemetrySample[]; sideEffects: readonly never[] } {
  const at = parseTime(input.at, "Simulation time");
  const sampleAt = input.scenario === "stale" ? at - 10 * 60 * 1000 : at;
  const base = {
    id: `sim-${input.scenario}-1`,
    resourceId: input.resourceId,
    portfolioId: input.portfolioId,
    companyId: input.companyId,
    authenticated: true,
    observedAt: new Date(sampleAt).toISOString(),
    cpuUtilizationPct: 35,
    memoryUtilizationPct: 40,
    diskUtilizationPct: 50,
    heartbeatOk: input.scenario !== "heartbeat-lost"
  };

  const sample: TelemetrySample = input.scenario === "degraded"
    ? { ...base, cpuUtilizationPct: 82 }
    : input.scenario === "saturated"
      ? { ...base, cpuUtilizationPct: 97 }
      : base;

  return Object.freeze({
    samples: Object.freeze([Object.freeze(sample)]),
    sideEffects: Object.freeze([])
  });
}
