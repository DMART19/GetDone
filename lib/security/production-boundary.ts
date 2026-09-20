import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import {
  assertVerificationReceipt,
  type VerificationReceipt
} from "@/lib/verification/verification";

export interface ProductionPromotionBoundary {
  source: "control-plane" | "provider" | "worker" | "ai-model" | "frontend";
  scope: TrustedExecutionScope;
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
  if (input.scope.environment !== "production") {
    throw new ControlPlaneError("FORBIDDEN", "Production promotion requires production scope");
  }
  if (!input.deploymentRef || !input.rollbackRef) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Production promotion requires deployment and rollback references"
    );
  }

  assertVerificationReceipt(input.verificationReceipt, {
    scope: input.scope,
    subject: { type: "deployment", id: input.deploymentRef },
    now,
    allowedVerdicts: ["verified"]
  });

  return input;
}
