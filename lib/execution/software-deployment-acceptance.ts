import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";

export const SOFTWARE_DEPLOYMENT_ACCEPTANCE_VERSION = "1.0.0";

export type DeploymentVerificationKind = "health" | "business";

export interface DeploymentProviderAcceptanceEvidence {
  provider: "vercel";
  target: "staging";
  deploymentReference: string;
  deploymentUrl: string;
  sourceCommitSha: string;
  acceptedAt: string;
  providerState: "READY";
  authoritativeSuccess: false;
  evidenceHash: string;
}

export interface IndependentDeploymentVerificationEvidence {
  source: "independent-http-verifier";
  kind: DeploymentVerificationKind;
  url: string;
  status: number;
  ok: boolean;
  observedAt: string;
  responseHash: string;
  evidenceHash: string;
}

export interface StagingRollbackAcceptanceEvidence {
  provider: "vercel";
  target: "staging";
  alias: string;
  fromDeploymentReference: string;
  toDeploymentReference: string;
  acceptedAt: string;
  providerAccepted: true;
  authoritativeRecovery: false;
  evidenceHash: string;
}

export interface SoftwareDeploymentAcceptanceRun {
  version: typeof SOFTWARE_DEPLOYMENT_ACCEPTANCE_VERSION;
  runId: string;
  repository: string;
  sourceCommitSha: string;
  startedAt: string;
  completedAt: string;
  goodDeployment: DeploymentProviderAcceptanceEvidence;
  goodVerification: readonly IndependentDeploymentVerificationEvidence[];
  badDeployment: DeploymentProviderAcceptanceEvidence;
  badVerification: readonly IndependentDeploymentVerificationEvidence[];
  rollback: StagingRollbackAcceptanceEvidence;
  recoveryVerification: readonly IndependentDeploymentVerificationEvidence[];
  status: "passed" | "failed";
  lineageHash: string;
}

function parseTimestamp(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return new Date(parsed).toISOString();
}

function requireNonEmpty(value: string, label: string) {
  if (!value.trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} is required`);
  }
  return value;
}

export function createDeploymentProviderAcceptanceEvidence(
  input: Omit<
    DeploymentProviderAcceptanceEvidence,
    "provider" | "target" | "providerState" | "authoritativeSuccess" | "evidenceHash"
  >
): DeploymentProviderAcceptanceEvidence {
  requireNonEmpty(input.deploymentReference, "deployment reference");
  requireNonEmpty(input.deploymentUrl, "deployment URL");
  requireNonEmpty(input.sourceCommitSha, "source commit SHA");
  const acceptedAt = parseTimestamp(input.acceptedAt, "provider acceptedAt");
  const base = {
    provider: "vercel" as const,
    target: "staging" as const,
    deploymentReference: input.deploymentReference,
    deploymentUrl: input.deploymentUrl,
    sourceCommitSha: input.sourceCommitSha,
    acceptedAt,
    providerState: "READY" as const,
    authoritativeSuccess: false as const
  };
  return Object.freeze({ ...base, evidenceHash: sha256Hex(base) });
}

export function createIndependentDeploymentVerificationEvidence(
  input: Omit<
    IndependentDeploymentVerificationEvidence,
    "source" | "evidenceHash"
  >
): IndependentDeploymentVerificationEvidence {
  requireNonEmpty(input.url, "verification URL");
  requireNonEmpty(input.responseHash, "verification response hash");
  if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599) {
    throw new ControlPlaneError("VALIDATION_FAILED", "verification status must be an HTTP status");
  }
  const observedAt = parseTimestamp(input.observedAt, "verification observedAt");
  const base = {
    ...input,
    source: "independent-http-verifier" as const,
    observedAt
  };
  return Object.freeze({ ...base, evidenceHash: sha256Hex(base) });
}

export function createStagingRollbackAcceptanceEvidence(
  input: Omit<
    StagingRollbackAcceptanceEvidence,
    "provider" | "target" | "providerAccepted" | "authoritativeRecovery" | "evidenceHash"
  >
): StagingRollbackAcceptanceEvidence {
  requireNonEmpty(input.alias, "staging alias");
  requireNonEmpty(input.fromDeploymentReference, "rollback source deployment");
  requireNonEmpty(input.toDeploymentReference, "rollback target deployment");
  if (input.fromDeploymentReference === input.toDeploymentReference) {
    throw new ControlPlaneError("VALIDATION_FAILED", "rollback must change deployment reference");
  }
  const acceptedAt = parseTimestamp(input.acceptedAt, "rollback acceptedAt");
  const base = {
    provider: "vercel" as const,
    target: "staging" as const,
    alias: input.alias,
    fromDeploymentReference: input.fromDeploymentReference,
    toDeploymentReference: input.toDeploymentReference,
    acceptedAt,
    providerAccepted: true as const,
    authoritativeRecovery: false as const
  };
  return Object.freeze({ ...base, evidenceHash: sha256Hex(base) });
}

function assertProviderEvidence(
  evidence: DeploymentProviderAcceptanceEvidence,
  expectedCommitSha: string
) {
  const { evidenceHash, ...base } = evidence;
  if (
    sha256Hex(base) !== evidenceHash
    || evidence.provider !== "vercel"
    || evidence.target !== "staging"
    || evidence.providerState !== "READY"
    || evidence.authoritativeSuccess !== false
    || evidence.sourceCommitSha !== expectedCommitSha
  ) {
    throw new ControlPlaneError("FORBIDDEN", "deployment provider acceptance evidence is invalid");
  }
}

function assertVerificationEvidence(evidence: IndependentDeploymentVerificationEvidence) {
  const { evidenceHash, ...base } = evidence;
  if (
    sha256Hex(base) !== evidenceHash
    || evidence.source !== "independent-http-verifier"
  ) {
    throw new ControlPlaneError("FORBIDDEN", "independent deployment verification evidence is invalid");
  }
  parseTimestamp(evidence.observedAt, "verification observedAt");
}

export function createSoftwareDeploymentAcceptanceRun(
  input: Omit<SoftwareDeploymentAcceptanceRun, "version" | "lineageHash">
): SoftwareDeploymentAcceptanceRun {
  requireNonEmpty(input.runId, "acceptance run id");
  requireNonEmpty(input.repository, "repository");
  requireNonEmpty(input.sourceCommitSha, "source commit SHA");
  const startedAt = parseTimestamp(input.startedAt, "acceptance startedAt");
  const completedAt = parseTimestamp(input.completedAt, "acceptance completedAt");
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "acceptance completion cannot precede start");
  }

  assertProviderEvidence(input.goodDeployment, input.sourceCommitSha);
  assertProviderEvidence(input.badDeployment, input.sourceCommitSha);
  for (const evidence of [
    ...input.goodVerification,
    ...input.badVerification,
    ...input.recoveryVerification
  ]) {
    assertVerificationEvidence(evidence);
  }

  const { evidenceHash: rollbackHash, ...rollbackBase } = input.rollback;
  if (
    sha256Hex(rollbackBase) !== rollbackHash
    || input.rollback.providerAccepted !== true
    || input.rollback.authoritativeRecovery !== false
    || input.rollback.fromDeploymentReference !== input.badDeployment.deploymentReference
    || input.rollback.toDeploymentReference !== input.goodDeployment.deploymentReference
  ) {
    throw new ControlPlaneError("FORBIDDEN", "rollback acceptance evidence does not match deployment lineage");
  }

  const goodPassed = input.goodVerification.length >= 2
    && input.goodVerification.some((item) => item.kind === "health" && item.ok)
    && input.goodVerification.some((item) => item.kind === "business" && item.ok)
    && input.goodVerification.every((item) => item.ok);
  const badWasCaught = input.badVerification.length > 0
    && input.badVerification.some((item) => !item.ok);
  const recovered = input.recoveryVerification.length >= 2
    && input.recoveryVerification.some((item) => item.kind === "health" && item.ok)
    && input.recoveryVerification.some((item) => item.kind === "business" && item.ok)
    && input.recoveryVerification.every((item) => item.ok);

  if (input.status === "passed" && (!goodPassed || !badWasCaught || !recovered)) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "passed rollback acceptance requires good health/business verification, detected bad deployment, and verified recovery"
    );
  }

  const base = {
    ...input,
    version: SOFTWARE_DEPLOYMENT_ACCEPTANCE_VERSION,
    startedAt,
    completedAt
  };
  return Object.freeze({ ...base, lineageHash: sha256Hex(base) });
}

export function assertSoftwareDeploymentAcceptanceRun(run: SoftwareDeploymentAcceptanceRun) {
  const { lineageHash, ...base } = run;
  if (sha256Hex(base) !== lineageHash) {
    throw new ControlPlaneError("FORBIDDEN", "software deployment acceptance lineage integrity check failed");
  }
  return createSoftwareDeploymentAcceptanceRun(base);
}
