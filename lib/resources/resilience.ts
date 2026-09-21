import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export const RESILIENCE_CONTRACT_VERSION = "1.1.0";

export type FailureDomainKind =
  | "host"
  | "rack"
  | "site"
  | "home"
  | "region"
  | "provider"
  | "partner-dc";

export type FailureDomainHealth =
  | "healthy"
  | "degraded"
  | "saturated"
  | "unreachable"
  | "failed"
  | "maintenance";

export interface FailureDomainSnapshot {
  id: string;
  portfolioId: string;
  companyId: string;
  kind: FailureDomainKind;
  parentDomainIds: readonly string[];
  health: FailureDomainHealth;
  circuitBreaker: "closed" | "open" | "half-open";
  allowExistingWork: boolean;
  observedAt: string;
  expiresAt: string;
  snapshotHash: string;
}

export interface FailureDomainAdmission {
  targetId: string;
  admittedForNewWork: boolean;
  keepExistingWork: boolean;
  reasons: readonly string[];
  evaluatedAt: string;
  admissionHash: string;
}

export type DrainState = "active" | "draining" | "drained" | "cancelled";

export interface DrainRecord {
  id: string;
  scope: Pick<TrustedExecutionScope, "portfolioId" | "companyId" | "environment">;
  target: Readonly<{ type: "resource" | "pool"; id: string }>;
  reason: string;
  state: DrainState;
  startedAt: string;
  updatedAt: string;
  runningWorkAtStart: number;
  remainingWork: number;
  recordHash: string;
}

export interface FailoverPlan {
  id: string;
  scope: Pick<TrustedExecutionScope, "portfolioId" | "companyId" | "environment">;
  jobId?: string;
  source: Readonly<{ type: "resource" | "pool"; id: string }>;
  target: Readonly<{ type: "resource" | "pool"; id: string }>;
  sourceFailureDomainIds: readonly string[];
  targetFailureDomainIds: readonly string[];
  reason: string;
  retryable: boolean;
  checkpointAware: boolean;
  estimatedTemporaryCostImpactCents: number;
  requiresIndependentVerification: true;
  createdAt: string;
  planHash: string;
}

export type FailoverState =
  | "proposed"
  | "authorized"
  | "dispatching"
  | "verifying"
  | "verified"
  | "failed"
  | "cancelled";

export interface FailoverRecord {
  id: string;
  planId: string;
  planHash: string;
  state: FailoverState;
  updatedAt: string;
  dispatchEvidenceId?: string;
  verificationReceiptId?: string;
  verificationReceiptHash?: string;
  verificationEvidenceHash?: string;
  postFailoverHealth?: "healthy" | "degraded" | "failed";
  authoritativeRecoveryClaimed: boolean;
  recordHash: string;
}

export interface FailoverVerificationEvidence {
  planId: string;
  planHash: string;
  dispatchEvidenceId: string;
  verificationReceiptId: string;
  verificationReceiptHash: string;
  postFailoverHealth: "healthy" | "degraded" | "failed";
  observedAt: string;
  evidenceHash: string;
}

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

export function createFailureDomainSnapshot(
  input: Omit<FailureDomainSnapshot, "snapshotHash">
): FailureDomainSnapshot {
  const observedAt = parseTime(input.observedAt, "failure-domain observedAt");
  const expiresAt = parseTime(input.expiresAt, "failure-domain expiresAt");
  if (expiresAt <= observedAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Failure-domain expiry must follow observation");
  }
  const base = {
    ...input,
    parentDomainIds: Object.freeze([...new Set(input.parentDomainIds)].sort()),
    observedAt: new Date(observedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString()
  };
  return Object.freeze({ ...base, snapshotHash: sha256Hex(base) });
}

export function evaluateFailureDomainAdmission(input: {
  targetId: string;
  domains: readonly FailureDomainSnapshot[];
  evaluatedAt: string;
}): FailureDomainAdmission {
  const evaluatedAt = parseTime(input.evaluatedAt, "failure-domain admission evaluatedAt");
  const reasons: string[] = [];
  let keepExistingWork = true;

  for (const domain of input.domains) {
    const { snapshotHash, ...base } = domain;
    if (sha256Hex(base) !== snapshotHash) {
      throw new ControlPlaneError("FORBIDDEN", "Failure-domain snapshot integrity check failed");
    }
    if (Date.parse(domain.observedAt) > evaluatedAt || Date.parse(domain.expiresAt) <= evaluatedAt) {
      reasons.push(`stale-domain:${domain.id}`);
      keepExistingWork = false;
      continue;
    }
    if (domain.circuitBreaker === "open") reasons.push(`circuit-open:${domain.id}`);
    if (["unreachable", "failed", "maintenance"].includes(domain.health)) {
      reasons.push(`domain-unavailable:${domain.id}`);
    }
    if (domain.health === "degraded" || domain.health === "saturated") {
      reasons.push(`domain-degraded:${domain.id}`);
    }
    if (!domain.allowExistingWork) keepExistingWork = false;
  }

  const hardBlock = reasons.some(
    (reason) =>
      reason.startsWith("stale-domain:")
      || reason.startsWith("circuit-open:")
      || reason.startsWith("domain-unavailable:")
      || reason.startsWith("domain-degraded:")
  );
  const base = {
    targetId: input.targetId,
    admittedForNewWork: !hardBlock,
    keepExistingWork: keepExistingWork && !reasons.some((r) => r.startsWith("domain-unavailable:")),
    reasons: Object.freeze(reasons),
    evaluatedAt: new Date(evaluatedAt).toISOString()
  };
  return Object.freeze({ ...base, admissionHash: sha256Hex(base) });
}

export function beginDrain(input: {
  id: string;
  scope: Pick<TrustedExecutionScope, "portfolioId" | "companyId" | "environment">;
  target: DrainRecord["target"];
  reason: string;
  runningWork: number;
  startedAt: string;
}): DrainRecord {
  if (!input.reason.trim() || !Number.isInteger(input.runningWork) || input.runningWork < 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Drain requires reason and non-negative running work");
  }
  const startedAt = new Date(parseTime(input.startedAt, "drain startedAt")).toISOString();
  const base = {
    id: input.id,
    scope: input.scope,
    target: input.target,
    reason: input.reason,
    state: "draining" as const,
    startedAt,
    updatedAt: startedAt,
    runningWorkAtStart: input.runningWork,
    remainingWork: input.runningWork
  };
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}

export function updateDrain(input: {
  current: DrainRecord;
  remainingWork: number;
  updatedAt: string;
  cancel?: boolean;
}): DrainRecord {
  const { recordHash, ...currentBase } = input.current;
  if (sha256Hex(currentBase) !== recordHash) {
    throw new ControlPlaneError("FORBIDDEN", "Drain record integrity check failed");
  }
  if (input.current.state !== "draining") {
    throw new ControlPlaneError("CONFLICT", "Only an active drain can be updated");
  }
  if (!Number.isInteger(input.remainingWork) || input.remainingWork < 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", "remainingWork must be non-negative");
  }
  const updatedAtMs = parseTime(input.updatedAt, "drain updatedAt");
  if (updatedAtMs < Date.parse(input.current.updatedAt)) {
    throw new ControlPlaneError("CONFLICT", "Drain time cannot move backwards");
  }
  if (input.remainingWork > input.current.remainingWork) {
    throw new ControlPlaneError("CONFLICT", "Drain remaining work cannot increase");
  }
  const state = input.cancel
    ? "cancelled" as const
    : input.remainingWork === 0
      ? "drained" as const
      : "draining" as const;
  const base = {
    ...currentBase,
    state,
    updatedAt: new Date(updatedAtMs).toISOString(),
    remainingWork: input.remainingWork
  };
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}

export function createFailoverPlan(input: Omit<FailoverPlan, "requiresIndependentVerification" | "planHash">) {
  if (input.source.type === input.target.type && input.source.id === input.target.id) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Failover target must differ from source");
  }
  if (!input.retryable && !input.checkpointAware) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Non-retryable non-checkpoint-aware work cannot be automatically failed over"
    );
  }
  if (!Number.isFinite(input.estimatedTemporaryCostImpactCents) || input.estimatedTemporaryCostImpactCents < 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Failover cost impact must be non-negative");
  }
  const sourceDomains = new Set(input.sourceFailureDomainIds);
  if (input.targetFailureDomainIds.some((id) => sourceDomains.has(id))) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Failover target must escape the correlated source failure domains"
    );
  }
  const base = {
    ...input,
    sourceFailureDomainIds: Object.freeze([...new Set(input.sourceFailureDomainIds)].sort()),
    targetFailureDomainIds: Object.freeze([...new Set(input.targetFailureDomainIds)].sort()),
    requiresIndependentVerification: true as const,
    createdAt: new Date(parseTime(input.createdAt, "failover createdAt")).toISOString()
  };
  return Object.freeze({ ...base, planHash: sha256Hex(base) });
}

export function createInitialFailoverRecord(plan: FailoverPlan): FailoverRecord {
  const base = {
    id: plan.id,
    planId: plan.id,
    planHash: plan.planHash,
    state: "proposed" as const,
    updatedAt: plan.createdAt,
    dispatchEvidenceId: undefined,
    verificationReceiptId: undefined,
    verificationReceiptHash: undefined,
    verificationEvidenceHash: undefined,
    postFailoverHealth: undefined,
    authoritativeRecoveryClaimed: false
  };
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}


export function createFailoverVerificationEvidence(
  input: Omit<FailoverVerificationEvidence, "evidenceHash">
): FailoverVerificationEvidence {
  if (
    !input.planId
    || !input.planHash
    || !input.dispatchEvidenceId
    || !input.verificationReceiptId
    || !input.verificationReceiptHash
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Failover verification evidence requires complete plan/dispatch/receipt lineage"
    );
  }
  const observedAt = new Date(parseTime(
    input.observedAt,
    "failover verification observedAt"
  )).toISOString();
  const base = { ...input, observedAt };
  return Object.freeze({ ...base, evidenceHash: sha256Hex(base) });
}

export function assertFailoverVerificationEvidence(input: {
  evidence: FailoverVerificationEvidence;
  record: FailoverRecord;
  now?: number;
}) {
  const { evidenceHash, ...base } = input.evidence;
  if (
    sha256Hex(base) !== evidenceHash
    || input.evidence.planId !== input.record.planId
    || input.evidence.planHash !== input.record.planHash
    || input.evidence.dispatchEvidenceId !== input.record.dispatchEvidenceId
    || input.evidence.postFailoverHealth !== "healthy"
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Failover verification evidence is forged, unhealthy, or outside failover lineage"
    );
  }
  const observedAt = parseTime(input.evidence.observedAt, "failover verification observedAt");
  if (observedAt < Date.parse(input.record.updatedAt)) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Failover verification evidence cannot predate the verifying state"
    );
  }
  if (input.now !== undefined && observedAt > input.now) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Failover verification evidence cannot come from the future"
    );
  }
  return input.evidence;
}

const allowed: Record<FailoverState, readonly FailoverState[]> = {
  proposed: ["authorized", "cancelled"],
  authorized: ["dispatching", "cancelled"],
  dispatching: ["verifying", "failed"],
  verifying: ["verified", "failed"],
  verified: [],
  failed: [],
  cancelled: []
};

export function transitionFailover(input: {
  current: FailoverRecord;
  to: FailoverState;
  updatedAt: string;
  dispatchEvidenceId?: string;
  verificationReceiptId?: string;
  verificationReceiptHash?: string;
  postFailoverHealth?: "healthy" | "degraded" | "failed";
  verificationEvidence?: FailoverVerificationEvidence;
}): FailoverRecord {
  const { recordHash, ...currentBase } = input.current;
  if (sha256Hex(currentBase) !== recordHash) {
    throw new ControlPlaneError("FORBIDDEN", "Failover record integrity check failed");
  }
  const updatedAtMs = parseTime(input.updatedAt, "failover updatedAt");
  if (updatedAtMs < Date.parse(input.current.updatedAt)) {
    throw new ControlPlaneError("CONFLICT", "Failover time cannot move backwards");
  }
  if (!allowed[input.current.state].includes(input.to)) {
    throw new ControlPlaneError(
      "CONFLICT",
      `Invalid failover transition ${input.current.state} -> ${input.to}`
    );
  }
  if (input.to === "verifying" && !(input.dispatchEvidenceId ?? input.current.dispatchEvidenceId)) {
    throw new ControlPlaneError("FORBIDDEN", "Failover verification requires dispatch evidence");
  }
  if (input.to === "verified") {
    if (!input.verificationEvidence) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Failover cannot claim recovery without hash-bound independent verification evidence"
      );
    }
    assertFailoverVerificationEvidence({
      evidence: input.verificationEvidence,
      record: input.current,
      now: updatedAtMs
    });
  }
  const base = {
    ...currentBase,
    state: input.to,
    updatedAt: new Date(updatedAtMs).toISOString(),
    dispatchEvidenceId: input.dispatchEvidenceId ?? input.current.dispatchEvidenceId,
    verificationReceiptId:
      input.verificationEvidence?.verificationReceiptId
      ?? input.verificationReceiptId
      ?? input.current.verificationReceiptId,
    verificationReceiptHash:
      input.verificationEvidence?.verificationReceiptHash
      ?? input.verificationReceiptHash
      ?? input.current.verificationReceiptHash,
    verificationEvidenceHash:
      input.verificationEvidence?.evidenceHash
      ?? input.current.verificationEvidenceHash,
    postFailoverHealth:
      input.verificationEvidence?.postFailoverHealth
      ?? input.postFailoverHealth
      ?? input.current.postFailoverHealth,
    authoritativeRecoveryClaimed: input.to === "verified"
  };
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}
