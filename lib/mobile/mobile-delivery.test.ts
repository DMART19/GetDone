import { describe, expect, it } from "vitest";
import {
  assertSafeInternalDeepLink,
  buildMobileDeepLink
} from "@/lib/mobile/deep-links";
import { planOwnerNotification } from "@/lib/mobile/notifications";
import { decidePwaUpdateAction } from "@/lib/mobile/update-policy";
import { assertWebAuthnCeremony } from "@/lib/auth/webauthn";

describe("Phase 25 mobile delivery contracts", () => {
  it("builds allowlisted internal deep links without granting authority", () => {
    expect(buildMobileDeepLink({
      kind: "resource-incident",
      resourceId: "resource-1",
      incidentId: "incident-9"
    })).toBe("/resources/resource-1?incident=incident-9");

    expect(buildMobileDeepLink({ kind: "resource-add" })).toBe("/resources/add");

    expect(() => assertSafeInternalDeepLink("//evil.example/path")).toThrow();
    expect(() => buildMobileDeepLink({
      kind: "decision",
      decisionId: "../admin"
    })).toThrow();
  });

  it("routes FYI/Normal without push and High/Critical to push", () => {
    expect(planOwnerNotification({
      id: "fyi-1",
      attention: "fyi",
      target: { kind: "task-result", taskId: "task-1" },
      sensitive: false,
      summary: "Completed"
    }).push).toBe(false);

    expect(planOwnerNotification({
      id: "high-1",
      attention: "high",
      target: { kind: "decision", decisionId: "decision-1" },
      sensitive: false,
      summary: "Revenue dropped 32%"
    }).push).toBe(true);
  });

  it("redacts high/sensitive lock-screen detail and requires server fetch", () => {
    const delivery = planOwnerNotification({
      id: "critical-1",
      attention: "critical",
      target: { kind: "resource", resourceId: "resource-1" },
      sensitive: true,
      summary: "Customer API key leaked: secret-value"
    });

    expect(delivery.lockScreenBody).not.toContain("secret-value");
    expect(delivery.requiresAuthoritativeFetch).toBe(true);
  });

  it("does not apply an update while offline, editing, or in strong approval", () => {
    expect(decidePwaUpdateAction({
      updateAvailable: true,
      online: false,
      hasUnsavedOwnerInput: false,
      strongApprovalInProgress: false
    })).toBe("defer");

    expect(decidePwaUpdateAction({
      updateAvailable: true,
      online: true,
      hasUnsavedOwnerInput: true,
      strongApprovalInProgress: false
    })).toBe("defer");

    expect(decidePwaUpdateAction({
      updateAvailable: true,
      online: true,
      hasUnsavedOwnerInput: false,
      strongApprovalInProgress: true
    })).toBe("defer");

    expect(decidePwaUpdateAction({
      updateAvailable: true,
      online: true,
      hasUnsavedOwnerInput: false,
      strongApprovalInProgress: false
    })).toBe("offer-reload");
  });

  it("rejects WebAuthn responses from the wrong origin or RP", () => {
    const ceremony = {
      id: "ceremony-1",
      type: "authentication" as const,
      rpId: "getdone.example",
      allowedOrigins: ["https://getdone.example"],
      challengeHash: "challenge-hash",
      issuedAt: "2026-09-20T20:55:00Z",
      expiresAt: "2026-09-20T21:05:00Z",
      requireUserVerification: true
    };
    const now = Date.parse("2026-09-20T21:00:00Z");

    expect(assertWebAuthnCeremony(ceremony, {
      ceremonyId: "ceremony-1",
      rpId: "getdone.example",
      origin: "https://getdone.example",
      credentialId: "credential-1",
      userVerified: true
    }, now).credentialId).toBe("credential-1");

    expect(() => assertWebAuthnCeremony(ceremony, {
      ceremonyId: "ceremony-1",
      rpId: "evil.example",
      origin: "https://evil.example",
      credentialId: "credential-1",
      userVerified: true
    }, now)).toThrow();
  });
  it("covers all supported deep-link target shapes and WebAuthn fail-closed branches", () => {
    expect(buildMobileDeepLink({ kind: "decision", decisionId: "decision-1" })).toBe("/decisions/decision-1");
    expect(buildMobileDeepLink({ kind: "task-result", taskId: "task-1" })).toBe("/?focus=task-result&id=task-1");
    expect(buildMobileDeepLink({ kind: "resource", resourceId: "resource-1" })).toBe("/resources/resource-1");
    expect(buildMobileDeepLink({
      kind: "resource-decision",
      resourceId: "resource-1",
      decisionId: "decision-1"
    })).toBe("/decisions/decision-1?resource=resource-1");
    expect(assertSafeInternalDeepLink("/resources/resource-1")).toBe("/resources/resource-1");
    expect(() => assertSafeInternalDeepLink("/../admin")).toThrow();

    const ceremony = {
      id: "ceremony-branches",
      type: "authentication" as const,
      rpId: "getdone.example",
      allowedOrigins: ["https://getdone.example"],
      challengeHash: "challenge",
      issuedAt: "2026-09-20T20:55:00Z",
      expiresAt: "2026-09-20T21:05:00Z",
      requireUserVerification: true
    };
    const valid = {
      ceremonyId: ceremony.id,
      rpId: ceremony.rpId,
      origin: "https://getdone.example",
      credentialId: "credential-1",
      userVerified: true
    };
    const now = Date.parse("2026-09-20T21:00:00Z");

    expect(() => assertWebAuthnCeremony(
      { ...ceremony, issuedAt: "bad-time" },
      valid,
      now
    )).toThrow(/valid timestamp/i);
    expect(() => assertWebAuthnCeremony(
      { ...ceremony, expiresAt: "2026-09-20T20:59:59Z" },
      valid,
      now
    )).toThrow(/expired or not active/i);
    expect(() => assertWebAuthnCeremony(
      ceremony,
      { ...valid, ceremonyId: "other" },
      now
    )).toThrow(/origin\/RP scope/i);
    expect(() => assertWebAuthnCeremony(
      ceremony,
      { ...valid, credentialId: "" },
      now
    )).toThrow(/credential identity/i);
    expect(() => assertWebAuthnCeremony(
      ceremony,
      { ...valid, userVerified: false },
      now
    )).toThrow(/user verification/i);

    expect(assertWebAuthnCeremony(
      { ...ceremony, requireUserVerification: false },
      { ...valid, userVerified: false },
      now
    ).userVerified).toBe(false);
  });

});
