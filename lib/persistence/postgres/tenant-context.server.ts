import { AsyncLocalStorage } from "node:async_hooks";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export interface PostgresTenantScope {
  portfolioId: string;
  companyId: string;
}

const tenantScopeStorage = new AsyncLocalStorage<PostgresTenantScope>();

function normalizeScope(
  scope: Pick<TrustedExecutionScope, "portfolioId" | "companyId"> | PostgresTenantScope
): PostgresTenantScope {
  const portfolioId = scope.portfolioId.trim();
  const companyId = scope.companyId.trim();
  if (
    portfolioId.length === 0
    || companyId.length === 0
    || portfolioId.length > 256
    || companyId.length > 256
    || portfolioId.includes("\0")
    || companyId.includes("\0")
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "PostgreSQL tenant scope requires bounded portfolio and company identifiers"
    );
  }
  return Object.freeze({ portfolioId, companyId });
}

export function runWithPostgresTenantScope<T>(
  scope: Pick<TrustedExecutionScope, "portfolioId" | "companyId"> | PostgresTenantScope,
  operation: () => T
): T {
  return tenantScopeStorage.run(normalizeScope(scope), operation);
}

export function getPostgresTenantScope(): PostgresTenantScope | null {
  return tenantScopeStorage.getStore() ?? null;
}
