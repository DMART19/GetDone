import { ControlPlaneError } from "@/lib/control-plane/errors";

export type ResourceFabricExternalClaimKind =
  | "resource-identity"
  | "enrollment-ready"
  | "heartbeat"
  | "capacity"
  | "reservation"
  | "placement";

export interface ResourceFabricExternalClaim {
  kind: ResourceFabricExternalClaimKind;
  source: "resource-agent" | "provider" | "frontend" | "ai-model";
  portfolioId: string;
  companyId: string;
  resourceId?: string;
  observedAt: string;
  nonce: string;
  independentEvidenceId?: string;
}

export interface ResourceFabricThreatScope {
  portfolioId: string;
  companyId: string;
  resourceId?: string;
}

export function assessResourceFabricExternalClaim(
  claim: ResourceFabricExternalClaim,
  scope: ResourceFabricThreatScope,
  input: {
    now?: number;
    maxAgeSeconds?: number;
    seenNonces?: ReadonlySet<string>;
  } = {}
) {
  const now = input.now ?? Date.now();
  const maxAgeSeconds = input.maxAgeSeconds ?? 300;
  const observedAt = Date.parse(claim.observedAt);

  if (
    claim.portfolioId !== scope.portfolioId
    || claim.companyId !== scope.companyId
    || (scope.resourceId && claim.resourceId !== scope.resourceId)
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Resource Fabric claim is outside trusted scope");
  }
  if (!claim.nonce || input.seenNonces?.has(claim.nonce)) {
    throw new ControlPlaneError("FORBIDDEN", "Resource Fabric claim nonce is missing or replayed");
  }
  if (
    !Number.isFinite(observedAt)
    || observedAt > now
    || now - observedAt > maxAgeSeconds * 1000
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Resource Fabric claim is stale or from the future");
  }

  if (
    ["resource-identity", "enrollment-ready", "heartbeat", "capacity"].includes(claim.kind)
    && !claim.independentEvidenceId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Privileged Resource Fabric claim requires independent verification evidence"
    );
  }

  return Object.freeze({
    acceptedAsEvidence: true,
    authoritative: false,
    requiresControlPlaneDecision: true,
    claimKind: claim.kind
  });
}
