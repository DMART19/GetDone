import { describe, expect, it } from "vitest";
import { authorizeSideEffect, type SideEffectPreflight } from "@/lib/domain/side-effect";

function preflight(overrides: Partial<SideEffectPreflight> = {}): SideEffectPreflight {
  return {
    authenticated: true,
    capability: "email.send",
    scopeResolved: true,
    policyAuthorized: true,
    authorizationGranted: true,
    idempotencyKey: "idem-side-effect-1",
    timeoutMs: 5_000,
    retryPolicyDefined: true,
    auditEnabled: true,
    verificationDefined: true,
    ...overrides
  };
}

describe("side-effect preflight authority", () => {
  it("authorizes a fully governed side effect and defaults cancellation to false", () => {
    expect(authorizeSideEffect(preflight())).toEqual({
      capability: "email.send",
      idempotencyKey: "idem-side-effect-1",
      timeoutMs: 5_000,
      cancellationDefined: false
    });
    expect(authorizeSideEffect(preflight({ cancellationDefined: true })).cancellationDefined).toBe(true);
  });

  it("fails closed for authentication, capability, scope, policy, and approval failures", () => {
    expect(() => authorizeSideEffect(preflight({ authenticated: false }))).toThrow(/Authentication/);
    expect(() => authorizeSideEffect(preflight({ capability: "unknown.capability" }))).toThrow(/unavailable/);
    expect(() => authorizeSideEffect(preflight({ scopeResolved: false }))).toThrow(/Trusted scope/);
    expect(() => authorizeSideEffect(preflight({ policyAuthorized: false }))).toThrow(/Policy blocked/);
    expect(() => authorizeSideEffect(preflight({ authorizationGranted: false }))).toThrow(/authorization has not been granted/);
  });

  it("allows an auto capability without a separate approval grant", () => {
    const result = authorizeSideEffect(preflight({
      capability: "revenue.read",
      authorizationGranted: false
    }));
    expect(result.capability).toBe("revenue.read");
  });

  it("requires idempotency, positive finite timeout, retry, audit, and verification contracts independently", () => {
    expect(() => authorizeSideEffect(preflight({ idempotencyKey: undefined }))).toThrow(/Idempotency key/);
    expect(() => authorizeSideEffect(preflight({ timeoutMs: 0 }))).toThrow(/Positive timeout/);
    expect(() => authorizeSideEffect(preflight({ timeoutMs: Number.NaN }))).toThrow(/Positive timeout/);
    expect(() => authorizeSideEffect(preflight({ retryPolicyDefined: false }))).toThrow(/Retry, audit, and verification/);
    expect(() => authorizeSideEffect(preflight({ auditEnabled: false }))).toThrow(/Retry, audit, and verification/);
    expect(() => authorizeSideEffect(preflight({ verificationDefined: false }))).toThrow(/Retry, audit, and verification/);
  });
});
