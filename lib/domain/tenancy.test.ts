import { describe, expect, it } from "vitest";
import { assertTrustedScope } from "@/lib/domain/tenancy";

const grant = {
  userId: "user-a",
  portfolioId: "portfolio-a",
  companyIds: ["company-a"],
  resourceIds: ["resource-a"]
};

describe("tenant scope", () => {
  it("accepts only trusted membership scope", () => {
    expect(assertTrustedScope(grant, { portfolioId: "portfolio-a", companyId: "company-a" }).companyId).toBe("company-a");
  });

  it("rejects company id tampering", () => {
    expect(() => assertTrustedScope(grant, { portfolioId: "portfolio-a", companyId: "company-b" })).toThrow();
  });

  it("rejects resource id tampering", () => {
    expect(() => assertTrustedScope(grant, { portfolioId: "portfolio-a", companyId: "company-a", resourceId: "resource-b" })).toThrow();
  });

  it("rejects revoked membership", () => {
    expect(() => assertTrustedScope({ ...grant, revokedAt: "2026-09-20T16:00:00Z" }, { portfolioId: "portfolio-a" })).toThrow();
  });
});
