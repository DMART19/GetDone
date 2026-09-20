import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import { assertTrustedExecutionScopeEqual } from "@/lib/control-plane/trusted-execution-scope";

export type StepUpMethod = "passkey" | "webauthn" | "reauthentication" | "hardware-key";
export type ApprovalLevel = "approval" | "strong-approval";

export interface StepUpProof {
  id: string;
  actorId: string;
  scope: TrustedExecutionScope;
  method: StepUpMethod;
  authenticatedAt: string;
  expiresAt: string;
}

export interface ApprovalProof {
  id: string;
  decisionId: string;
  approvalId: string;
  actorId: string;
  scope: TrustedExecutionScope;
  level: ApprovalLevel;
  planHash: string;
  stepHash: string;
  grantedAt: string;
  expiresAt: string;
  stepUpProofId?: string;
}

function assertTimeWindow(issuedAt: string, expiresAt: string, now: number, label: string) {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > expires) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} has an invalid time window`);
  }
  if (issued > now) throw new ControlPlaneError("FORBIDDEN", `${label} is not active yet`);
  if (expires <= now) throw new ControlPlaneError("FORBIDDEN", `${label} has expired`);
}

export function assertStepUpProof(proof: StepUpProof, input: {
  actorId: string;
  scope: TrustedExecutionScope;
  now?: number;
}) {
  assertTrustedExecutionScopeEqual(input.scope, proof.scope, {
    requireSameResource: Boolean(input.scope.resourceId || proof.scope.resourceId)
  });
  if (proof.actorId !== input.actorId) {
    throw new ControlPlaneError("FORBIDDEN", "Step-up proof belongs to a different actor");
  }
  assertTimeWindow(proof.authenticatedAt, proof.expiresAt, input.now ?? Date.now(), "Step-up proof");
  return proof;
}

export function assertApprovalProof(proof: ApprovalProof, input: {
  actorId?: string;
  scope: TrustedExecutionScope;
  planHash: string;
  stepHash: string;
  requiredLevel: ApprovalLevel;
  now?: number;
  stepUpProof?: StepUpProof;
}) {
  assertTrustedExecutionScopeEqual(input.scope, proof.scope, {
    requireSameResource: Boolean(input.scope.resourceId || proof.scope.resourceId)
  });

  if (input.actorId && proof.actorId !== input.actorId) {
    throw new ControlPlaneError("FORBIDDEN", "Approval proof belongs to a different actor");
  }
  if (proof.planHash !== input.planHash || proof.stepHash !== input.stepHash) {
    throw new ControlPlaneError("FORBIDDEN", "Approval proof does not match the approved plan/step");
  }
  if (input.requiredLevel === "strong-approval" && proof.level !== "strong-approval") {
    throw new ControlPlaneError("FORBIDDEN", "Strong approval proof is required");
  }

  const now = input.now ?? Date.now();
  assertTimeWindow(proof.grantedAt, proof.expiresAt, now, "Approval proof");

  if (proof.level === "strong-approval") {
    if (!input.stepUpProof || proof.stepUpProofId !== input.stepUpProof.id) {
      throw new ControlPlaneError("FORBIDDEN", "Strong approval must reference a valid step-up proof");
    }
    assertStepUpProof(input.stepUpProof, {
      actorId: proof.actorId,
      scope: proof.scope,
      now
    });
  }

  return proof;
}
