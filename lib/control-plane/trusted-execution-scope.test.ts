import { describe, expect, it } from "vitest";
import { createRequestContext } from "@/lib/control-plane/request-context";
import {
  assertTrustedExecutionScopeEqual,
  requireTrustedExecutionScope
} from "@/lib/control-plane/trusted-execution-scope";

describe("trusted execution scope", () => {
  const request = createRequestContext({
    actor: { type: "user", id: "user-a" },
    scope: {
      userId: "user-a",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      resourceId: "resource-a"
    },
    environment: "staging",
    correlationId: "scope-1"
  });

  it("requires portfolio and company authority", () => {
    expect(requireTrustedExecutionScope(request)).toEqual({
      userId: "user-a",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "staging",
      resourceId: "resource-a"
    });
  });

  it("rejects cross-portfolio or cross-company equality", () => {
    const scope = requireTrustedExecutionScope(request);
    expect(() => assertTrustedExecutionScopeEqual(scope, {
      ...scope,
      companyId: "company-b"
    })).toThrow();

    expect(() => assertTrustedExecutionScopeEqual(scope, {
      ...scope,
      portfolioId: "portfolio-b"
    })).toThrow();
  });

  it("can enforce exact resource identity", () => {
    const scope = requireTrustedExecutionScope(request);
    expect(() => assertTrustedExecutionScopeEqual(scope, {
      ...scope,
      resourceId: "resource-b"
    }, { requireSameResource: true })).toThrow();
  });
});
