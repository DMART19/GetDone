import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { AssembledContext } from "@/lib/intelligence/context";
import type { AICallAuditRecord, AIRouteDecision } from "@/lib/ai-gateway/contracts";
import type { PlanProposal } from "@/lib/planning/plan-schema";
import type { PlanValidatorAttestation } from "@/lib/planning/plan-validator";
import { assertPolicySnapshotIntegrity, type PolicySnapshot } from "@/lib/planning/policy-snapshot";
import type {
  PolicyDisposition,
  StepPolicyEvaluation
} from "@/lib/planning/policy-engine";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";

export const ORCHESTRATION_PLANNING_ARTIFACT_CONTRACT_VERSION = "1.0.0";

export type OrchestrationPlanningArtifactKind =
  | "context-snapshot"
  | "plan-proposal"
  | "validation-attestation"
  | "policy-bundle";

export interface OrchestrationContextSnapshot {
  id: string;
  runId: string;
  correlationId: string;
  portfolioId: string;
  companyId: string;
  environment: OrchestrationRun["environment"];
  dataClass: "public" | "internal" | "customer" | "sensitive";
  assembled: AssembledContext;
  createdAt: string;
  contextHash: string;
}

export interface GovernedPlanArtifact {
  id: string;
  runId: string;
  correlationId: string;
  contextSnapshotId: string;
  contextHash: string;
  plan: PlanProposal;
  planHash: string;
  aiAudit: AICallAuditRecord;
  aiAuditHash: string;
  route: AIRouteDecision;
  routeDecisionHash: string;
  authorityApplied: false;
  plannedAt: string;
  artifactHash: string;
}

export interface PlanValidationArtifact {
  id: string;
  runId: string;
  correlationId: string;
  planArtifactId: string;
  planHash: string;
  attestation: PlanValidatorAttestation;
  validationStatus: PlanValidatorAttestation["status"];
  authorityApplied: false;
  createdAt: string;
  artifactHash: string;
}

export interface StepPolicyArtifact {
  stepId: string;
  stepHash: string;
  snapshot: PolicySnapshot;
  evaluation: StepPolicyEvaluation;
}

export interface PolicyBundleArtifact {
  id: string;
  runId: string;
  correlationId: string;
  planArtifactId: string;
  planHash: string;
  validationArtifactId: string;
  validationAttestationHash: string;
  strongestDisposition: PolicyDisposition;
  ownerDecisionRequired: boolean;
  stepPolicies: readonly StepPolicyArtifact[];
  authorityApplied: false;
  createdAt: string;
  bundleHash: string;
}

export type OrchestrationPlanningArtifact =
  | Readonly<{ kind: "context-snapshot"; value: OrchestrationContextSnapshot }>
  | Readonly<{ kind: "plan-proposal"; value: GovernedPlanArtifact }>
  | Readonly<{ kind: "validation-attestation"; value: PlanValidationArtifact }>
  | Readonly<{ kind: "policy-bundle"; value: PolicyBundleArtifact }>;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function assertTimestamp(value: string, label: string) {
  if (!Number.isFinite(Date.parse(value))) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
}

export function createContextSnapshot(input: Omit<OrchestrationContextSnapshot, "contextHash">) {
  assertTimestamp(input.createdAt, "context snapshot createdAt");
  const base = {
    ...input,
    assembled: input.assembled
  };
  return deepFreeze({
    ...base,
    contextHash: sha256Hex(base)
  });
}

export function assertContextSnapshotIntegrity(snapshot: OrchestrationContextSnapshot) {
  const { contextHash, ...base } = snapshot;
  if (sha256Hex(base) !== contextHash) {
    throw new ControlPlaneError("FORBIDDEN", "Orchestration context snapshot integrity failed");
  }
  return snapshot;
}

export function createGovernedPlanArtifact(
  input: Omit<GovernedPlanArtifact, "aiAuditHash" | "routeDecisionHash" | "authorityApplied" | "artifactHash">
) {
  assertTimestamp(input.plannedAt, "governed plan plannedAt");
  const base = {
    ...input,
    aiAuditHash: input.aiAudit.auditHash,
    routeDecisionHash: input.route.decisionHash,
    authorityApplied: false as const
  };
  return deepFreeze({
    ...base,
    artifactHash: sha256Hex(base)
  });
}

export function assertGovernedPlanArtifactIntegrity(artifact: GovernedPlanArtifact) {
  const { artifactHash, ...base } = artifact;
  if (
    sha256Hex(base) !== artifactHash
    || artifact.authorityApplied !== false
    || artifact.aiAuditHash !== artifact.aiAudit.auditHash
    || artifact.routeDecisionHash !== artifact.route.decisionHash
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Governed plan artifact integrity failed");
  }
  return artifact;
}

export function createPlanValidationArtifact(
  input: Omit<PlanValidationArtifact, "validationStatus" | "authorityApplied" | "artifactHash">
) {
  assertTimestamp(input.createdAt, "plan validation artifact createdAt");
  const base = {
    ...input,
    validationStatus: input.attestation.status,
    authorityApplied: false as const
  };
  return deepFreeze({
    ...base,
    artifactHash: sha256Hex(base)
  });
}

export function assertPlanValidationArtifactIntegrity(artifact: PlanValidationArtifact) {
  const { artifactHash, ...base } = artifact;
  if (
    sha256Hex(base) !== artifactHash
    || artifact.authorityApplied !== false
    || artifact.validationStatus !== artifact.attestation.status
    || artifact.planHash !== artifact.attestation.planHash
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Plan validation artifact integrity failed");
  }
  return artifact;
}

export function createPolicyBundleArtifact(
  input: Omit<PolicyBundleArtifact, "authorityApplied" | "bundleHash">
) {
  assertTimestamp(input.createdAt, "policy bundle createdAt");
  const base = {
    ...input,
    stepPolicies: [...input.stepPolicies],
    authorityApplied: false as const
  };
  return deepFreeze({
    ...base,
    bundleHash: sha256Hex(base)
  });
}

export function assertPolicyBundleArtifactIntegrity(artifact: PolicyBundleArtifact) {
  const { bundleHash, ...base } = artifact;
  if (
    sha256Hex(base) !== bundleHash
    || artifact.authorityApplied !== false
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Policy bundle artifact integrity failed");
  }

  for (const step of artifact.stepPolicies) {
    assertPolicySnapshotIntegrity(step.snapshot);
    if (
      step.stepHash !== step.snapshot.stepHash
      || artifact.planHash !== step.snapshot.planHash
      || step.evaluation.policyEngineVersion !== step.snapshot.policyEngineVersion
      || step.evaluation.policyRulesHash !== step.snapshot.policyRulesHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Nested policy snapshot/evaluation integrity failed"
      );
    }
  }
  return artifact;
}

export function planningArtifactId(input: {
  kind: OrchestrationPlanningArtifactKind;
  runId: string;
  predecessorHash: string;
}) {
  return `orchestration-artifact:${input.kind}:${sha256Hex({
    runId: input.runId,
    predecessorHash: input.predecessorHash
  })}`;
}
