import { ControlPlaneError } from "@/lib/control-plane/errors";

export interface MembershipGrant {
  userId: string;
  portfolioId: string;
  companyIds: readonly string[];
  resourceIds?: readonly string[];
  revokedAt?: string;
}

export interface RequestedScope {
  portfolioId: string;
  companyId?: string;
  resourceId?: string;
}

export function assertTrustedScope(grant: MembershipGrant, request: RequestedScope) {
  if (grant.revokedAt) {
    throw new ControlPlaneError("FORBIDDEN", "Membership has been revoked");
  }

  if (grant.portfolioId !== request.portfolioId) {
    throw new ControlPlaneError("FORBIDDEN", "Portfolio scope is not authorized");
  }

  if (request.companyId && !grant.companyIds.includes(request.companyId)) {
    throw new ControlPlaneError("FORBIDDEN", "Company scope is not authorized");
  }

  if (request.resourceId) {
    const resources = grant.resourceIds ?? [];
    if (!resources.includes(request.resourceId)) {
      throw new ControlPlaneError("FORBIDDEN", "Resource scope is not authorized");
    }
  }

  return {
    userId: grant.userId,
    portfolioId: grant.portfolioId,
    companyId: request.companyId,
    resourceId: request.resourceId
  };
}
