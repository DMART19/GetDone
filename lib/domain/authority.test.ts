import { describe, expect, it } from "vitest";
import { isNewWorkBlocked } from "@/lib/domain/kill-switch";
import { authorizeSideEffect } from "@/lib/domain/side-effect";

describe("authority safeguards", () => {
  it("blocks work under an applicable kill switch", () => {
    const blocked = isNewWorkBlocked([
      {
        id: "ks-1",
        scopeType: "company",
        scopeId: "company-a",
        enabled: true,
        reason: "incident",
        activatedAt: "2026-09-20T16:00:00Z",
        activatedBy: "user-a"
      }
    ], { portfolioId: "portfolio-a", companyId: "company-a", capability: "email.send" });

    expect(blocked).toBe(true);
  });

  it("requires authorization for a non-auto side effect", () => {
    expect(() => authorizeSideEffect({
      authenticated: true,
      capability: "email.send",
      scopeResolved: true,
      policyAuthorized: true,
      authorizationGranted: false,
      idempotencyKey: "email-send-123",
      timeoutMs: 10_000,
      retryPolicyDefined: true,
      auditEnabled: true,
      verificationDefined: true
    })).toThrow();
  });

  it("admits a fully defined authorized side effect contract", () => {
    const authorization = authorizeSideEffect({
      authenticated: true,
      capability: "email.send",
      scopeResolved: true,
      policyAuthorized: true,
      authorizationGranted: true,
      idempotencyKey: "email-send-123",
      timeoutMs: 10_000,
      retryPolicyDefined: true,
      auditEnabled: true,
      verificationDefined: true,
      cancellationDefined: true
    });

    expect(authorization.capability).toBe("email.send");
  });
});
