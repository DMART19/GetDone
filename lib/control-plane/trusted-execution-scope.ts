import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { GetDoneEnvironment, RequestContext } from "@/lib/control-plane/request-context";

export interface TrustedExecutionScope {
  userId: string;
  portfolioId: string;
  companyId: string;
  environment: GetDoneEnvironment;
  resourceId?: string;
}

export function requireTrustedExecutionScope(context: RequestContext): TrustedExecutionScope {
  if (!context.scope.portfolioId || !context.scope.companyId) {
    throw new ControlPlaneError("FORBIDDEN", "Authoritative portfolio/company scope is required", {
      correlationId: context.correlationId
    });
  }

  return Object.freeze({
    userId: context.scope.userId,
    portfolioId: context.scope.portfolioId,
    companyId: context.scope.companyId,
    environment: context.environment,
    resourceId: context.scope.resourceId
  });
}

export function assertTrustedExecutionScopeEqual(
  expected: TrustedExecutionScope,
  actual: TrustedExecutionScope,
  options: { requireSameResource?: boolean } = {}
) {
  if (
    expected.userId !== actual.userId
    || expected.portfolioId !== actual.portfolioId
    || expected.companyId !== actual.companyId
    || expected.environment !== actual.environment
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Trusted execution scopes do not match");
  }

  if (
    options.requireSameResource
    && expected.resourceId !== actual.resourceId
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Trusted resource scope does not match");
  }
}

export function trustedScopeKey(scope: TrustedExecutionScope) {
  return [
    scope.userId,
    scope.portfolioId,
    scope.companyId,
    scope.environment,
    scope.resourceId ?? "-"
  ].join(":");
}
