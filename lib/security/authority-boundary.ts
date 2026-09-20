import { ControlPlaneError } from "@/lib/control-plane/errors";

export type AuthorityClaimSource =
  | "control-plane"
  | "ai-model"
  | "ai-gateway"
  | "provider"
  | "callback"
  | "frontend"
  | "resource-agent";

export type ProtectedAuthority =
  | "approval"
  | "authorization"
  | "job-success"
  | "outcome-truth"
  | "resource-ready"
  | "policy-mutation"
  | "credential-expansion"
  | "production-deploy";

const protectedKeys = new Set([
  "approved",
  "approvalGranted",
  "authorizationGranted",
  "policyAuthorized",
  "jobSuccess",
  "jobState",
  "outcomeVerified",
  "resourceReady",
  "resourceState",
  "credentialScope",
  "credentialScopes",
  "productionAuthorized",
  "deploymentApproved"
]);

export function assertAuthoritativeMutationSource(
  source: AuthorityClaimSource,
  authority: ProtectedAuthority
) {
  if (source !== "control-plane") {
    throw new ControlPlaneError(
      "FORBIDDEN",
      `${source} cannot establish authoritative ${authority}`
    );
  }
  return { source, authority };
}

export function assertUntrustedPayloadContainsNoAuthorityClaims(value: unknown) {
  const visit = (item: unknown, path: string) => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (protectedKeys.has(key)) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          `Untrusted payload attempted to set protected authority field ${path}.${key}`
        );
      }
      visit(child, `${path}.${key}`);
    }
  };

  visit(value, "$");
  return value;
}
