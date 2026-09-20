import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { VerificationReceipt } from "@/lib/verification/verification";

export interface ProductionPromotionBoundary {
  source: "control-plane" | "provider" | "worker" | "ai-model" | "frontend";
  authenticated: boolean;
  trustedScopeResolved: boolean;
  policyAuthorized: boolean;
  approvalProofVerified: boolean;
  verificationReceipt: VerificationReceipt;
  deploymentRef: string;
  rollbackRef: string;
}

export function assertProductionPromotionBoundary(
  input: ProductionPromotionBoundary,
  now = Date.now()
) {
  if (input.source !== "control-plane") {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Only the control plane may authorize production promotion"
    );
  }
  if (!input.authenticated) {
    throw new ControlPlaneError("UNAUTHENTICATED", "Production promotion requires authentication");
  }
  if (!input.trustedScopeResolved || !input.policyAuthorized || !input.approvalProofVerified) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Production promotion requires trusted scope, policy, and verified approval"
    );
  }
  if (!input.deploymentRef || !input.rollbackRef) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Production promotion requires deployment and rollback references"
    );
  }

  const receipt = input.verificationReceipt;
  if (
    receipt.verdict !== "verified"
    || receipt.subject.type !== "deployment"
    || Date.parse(receipt.verifiedAt) > now
    || Date.parse(receipt.expiresAt) <= now
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Production promotion requires a fresh verified deployment receipt"
    );
  }

  return input;
}
