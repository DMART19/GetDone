import { describe, expect, it } from "vitest";
import {
  getPostgresTenantScope,
  runWithPostgresTenantScope
} from "@/lib/persistence/postgres/tenant-context.server";

describe("PostgreSQL tenant scope context", () => {
  it("propagates trusted portfolio/company scope across async work", async () => {
    expect(getPostgresTenantScope()).toBeNull();

    const value = await runWithPostgresTenantScope(
      { portfolioId: "portfolio-a", companyId: "company-a" },
      async () => {
        await Promise.resolve();
        expect(getPostgresTenantScope()).toEqual({
          portfolioId: "portfolio-a",
          companyId: "company-a"
        });
        return "scoped";
      }
    );

    expect(value).toBe("scoped");
    expect(getPostgresTenantScope()).toBeNull();
  });

  it("restores an outer tenant scope after nested work", () => {
    runWithPostgresTenantScope(
      { portfolioId: "portfolio-a", companyId: "company-a" },
      () => {
        expect(getPostgresTenantScope()?.companyId).toBe("company-a");
        runWithPostgresTenantScope(
          { portfolioId: "portfolio-b", companyId: "company-b" },
          () => {
            expect(getPostgresTenantScope()?.companyId).toBe("company-b");
          }
        );
        expect(getPostgresTenantScope()?.companyId).toBe("company-a");
      }
    );
    expect(getPostgresTenantScope()).toBeNull();
  });

  it("fails closed for missing, oversized, or NUL-bearing tenant identifiers", () => {
    expect(() => runWithPostgresTenantScope(
      { portfolioId: "", companyId: "company-a" },
      () => undefined
    )).toThrow(/bounded portfolio and company identifiers/);

    expect(() => runWithPostgresTenantScope(
      { portfolioId: "portfolio-a", companyId: "x".repeat(257) },
      () => undefined
    )).toThrow(/bounded portfolio and company identifiers/);

    expect(() => runWithPostgresTenantScope(
      { portfolioId: "portfolio\0a", companyId: "company-a" },
      () => undefined
    )).toThrow(/bounded portfolio and company identifiers/);
  });
});
