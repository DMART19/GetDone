import { ControlPlaneError } from "@/lib/control-plane/errors";
import { requireEnabledCapability } from "@/lib/domain/capabilities";

export interface SideEffectPreflight {
  authenticated: boolean;
  capability: string;
  scopeResolved: boolean;
  policyAuthorized: boolean;
  authorizationGranted: boolean;
  idempotencyKey?: string;
  timeoutMs: number;
  retryPolicyDefined: boolean;
  auditEnabled: boolean;
  verificationDefined: boolean;
  cancellationDefined?: boolean;
}

export interface SideEffectAuthorization {
  capability: string;
  idempotencyKey: string;
  timeoutMs: number;
  cancellationDefined: boolean;
}

export function authorizeSideEffect(preflight: SideEffectPreflight): SideEffectAuthorization {
  if (!preflight.authenticated) {
    throw new ControlPlaneError("UNAUTHENTICATED", "Authentication is required");
  }

  const capability = requireEnabledCapability(preflight.capability);

  if (!preflight.scopeResolved) {
    throw new ControlPlaneError("FORBIDDEN", "Trusted scope is required");
  }
  if (!preflight.policyAuthorized || capability.approval === "blocked") {
    throw new ControlPlaneError("POLICY_BLOCKED", "Policy blocked the requested side effect");
  }
  if (!preflight.authorizationGranted && capability.approval !== "auto") {
    throw new ControlPlaneError("FORBIDDEN", "Required authorization has not been granted");
  }
  if (!preflight.idempotencyKey) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Idempotency key is required");
  }
  if (!Number.isFinite(preflight.timeoutMs) || preflight.timeoutMs <= 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Positive timeout is required");
  }
  if (!preflight.retryPolicyDefined || !preflight.auditEnabled || !preflight.verificationDefined) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Retry, audit, and verification contracts are required");
  }

  return {
    capability: capability.name,
    idempotencyKey: preflight.idempotencyKey,
    timeoutMs: preflight.timeoutMs,
    cancellationDefined: preflight.cancellationDefined ?? false
  };
}
