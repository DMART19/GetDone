import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { assertTrustedExecutionScopeEqual, type TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { TrustedActor } from "@/lib/control-plane/request-context";
import { assertApprovalProof, type ApprovalProof, type StepUpProof } from "@/lib/authorization/proofs";
import type { StepPolicyEvaluation } from "@/lib/planning/policy-engine";
import type { PolicySnapshot } from "@/lib/planning/policy-snapshot";
import { hashPlan, hashPlanStep } from "@/lib/planning/plan-hash";
import type { PlanProposal } from "@/lib/planning/plan-schema";
import { assertValidationReceipt, type PlanValidationReceipt } from "@/lib/planning/validation-receipt";

export type AuthorizationGrantDisposition = "AUTO" | "APPROVAL_REQUIRED" | "STRONG_APPROVAL";
export type AuthorizationGrantStatus = "active" | "consumed" | "revoked";

export interface AuthorizationGrant {
  id: string;
  status: AuthorizationGrantStatus;
  disposition: AuthorizationGrantDisposition;
  scope: TrustedExecutionScope;
  planId: string;
  planHash: string;
  stepId: string;
  stepHash: string;
  capabilityNames: readonly string[];
  validationReceiptId: string;
  validationReceiptHash: string;
  policySnapshotId: string;
  policySnapshotHash: string;
  decisionId?: string;
  approvalProofId?: string;
  stepUpProofId?: string;
  actor: TrustedActor;
  issuedAt: string;
  expiresAt: string;
  grantHash: string;
}

export interface AuthorizationGrantStore {
  get(id: string): Promise<AuthorizationGrant | null>;
  consume(id: string, grantHash: string, consumedById: string, consumedAt: string): Promise<void>;
  revoke(id: string, reason: string, revokedAt: string): Promise<void>;
}

function stepFor(plan: PlanProposal, stepId: string) {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new ControlPlaneError("NOT_FOUND", "Plan step was not found");
  return step;
}

function sameCapabilities(left: readonly string[], right: readonly string[]) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function assertScopeMatchesPlan(scope: TrustedExecutionScope, plan: PlanProposal) {
  if (
    scope.portfolioId !== plan.scope.portfolioId
    || scope.companyId !== plan.scope.companyId
    || scope.environment !== plan.scope.environment
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Authorization scope does not match the plan scope");
  }
}

export function issueAuthorizationGrant(input: {
  id: string;
  plan: PlanProposal;
  stepId: string;
  receipt: PlanValidationReceipt;
  policySnapshot: PolicySnapshot;
  policyEvaluation: StepPolicyEvaluation;
  actor: TrustedActor;
  scope: TrustedExecutionScope;
  approvalProof?: ApprovalProof;
  stepUpProof?: StepUpProof;
  issuedAt: string;
  expiresAt: string;
}): AuthorizationGrant {
  const issuedAt = Date.parse(input.issuedAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Authorization grant expiry must follow issue time");
  }

  assertValidationReceipt(input.receipt, input.plan, issuedAt);
  assertScopeMatchesPlan(input.scope, input.plan);

  const step = stepFor(input.plan, input.stepId);
  const planHash = hashPlan(input.plan);
  const stepHash = hashPlanStep(step);

  assertTrustedExecutionScopeEqual(input.scope, input.policySnapshot.scope, {
    requireSameResource: Boolean(input.scope.resourceId || input.policySnapshot.scope.resourceId)
  });

  if (
    input.policySnapshot.planHash !== planHash
    || input.policySnapshot.stepHash !== stepHash
    || !sameCapabilities(input.policySnapshot.capabilityNames, step.capabilityRequests.map((request) => request.capability))
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Policy snapshot does not match the plan step");
  }

  if (input.policyEvaluation.disposition === "BLOCKED" || !input.policyEvaluation.readyForTaskGeneration) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Policy evaluation does not authorize task generation");
  }

  if (input.policyEvaluation.disposition !== "AUTO") {
    if (!input.approvalProof) {
      throw new ControlPlaneError("FORBIDDEN", "Approval proof is required to issue this grant");
    }
    assertApprovalProof(input.approvalProof, {
      scope: input.scope,
      planHash,
      stepHash,
      requiredLevel: input.policyEvaluation.disposition === "STRONG_APPROVAL"
        ? "strong-approval"
        : "approval",
      now: issuedAt,
      stepUpProof: input.stepUpProof
    });
    if (Date.parse(input.approvalProof.expiresAt) < expiresAt) {
      throw new ControlPlaneError("FORBIDDEN", "Authorization grant cannot outlive its approval proof");
    }
    if (input.stepUpProof && Date.parse(input.stepUpProof.expiresAt) < expiresAt) {
      throw new ControlPlaneError("FORBIDDEN", "Authorization grant cannot outlive its step-up proof");
    }
  }

  const base = {
    id: input.id,
    status: "active" as const,
    disposition: input.policyEvaluation.disposition as AuthorizationGrantDisposition,
    scope: { ...input.scope },
    planId: input.plan.id,
    planHash,
    stepId: input.stepId,
    stepHash,
    capabilityNames: [...new Set(step.capabilityRequests.map((request) => request.capability))].sort(),
    validationReceiptId: input.receipt.id,
    validationReceiptHash: input.receipt.receiptHash,
    policySnapshotId: input.policySnapshot.id,
    policySnapshotHash: input.policySnapshot.snapshotHash,
    decisionId: input.approvalProof?.decisionId,
    approvalProofId: input.approvalProof?.id,
    stepUpProofId: input.stepUpProof?.id,
    actor: { ...input.actor },
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt
  };

  return Object.freeze({
    ...base,
    scope: Object.freeze(base.scope),
    capabilityNames: Object.freeze(base.capabilityNames),
    actor: Object.freeze(base.actor),
    grantHash: sha256Hex(base)
  });
}

export function assertAuthorizationGrant(input: {
  grant: AuthorizationGrant;
  plan: PlanProposal;
  stepId: string;
  receipt: PlanValidationReceipt;
  scope: TrustedExecutionScope;
  now?: number;
}) {
  const { grantHash, ...base } = input.grant;
  if (sha256Hex(base) !== grantHash) {
    throw new ControlPlaneError("FORBIDDEN", "Authorization grant integrity check failed");
  }
  if (input.grant.status !== "active") {
    throw new ControlPlaneError("FORBIDDEN", "Authorization grant is not active");
  }

  assertValidationReceipt(input.receipt, input.plan, input.now);
  assertScopeMatchesPlan(input.grant.scope, input.plan);
  assertScopeMatchesPlan(input.scope, input.plan);
  assertTrustedExecutionScopeEqual(input.scope, input.grant.scope, {
    requireSameResource: Boolean(input.scope.resourceId || input.grant.scope.resourceId)
  });

  const step = stepFor(input.plan, input.stepId);
  if (
    input.grant.planId !== input.plan.id
    || input.grant.planHash !== hashPlan(input.plan)
    || input.grant.stepId !== step.id
    || input.grant.stepHash !== hashPlanStep(step)
    || input.grant.validationReceiptId !== input.receipt.id
    || input.grant.validationReceiptHash !== input.receipt.receiptHash
    || !sameCapabilities(input.grant.capabilityNames, step.capabilityRequests.map((request) => request.capability))
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Authorization grant does not match the current plan/step/receipt");
  }

  const now = input.now ?? Date.now();
  if (Date.parse(input.grant.issuedAt) > now || Date.parse(input.grant.expiresAt) <= now) {
    throw new ControlPlaneError("FORBIDDEN", "Authorization grant is not currently valid");
  }

  return input.grant;
}
