import { describe, expect, it } from "vitest";
import type { AuthAdapter, AuthSession } from "@/lib/auth/contracts";
import { authorizeRequest } from "@/lib/auth/guard";

const now = Date.now();
function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    sessionId: "session-1",
    userId: "user-1",
    issuedAt: new Date(now - 60_000).toISOString(),
    authenticatedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    ...overrides
  };
}

function adapter(value: AuthSession | null): AuthAdapter {
  return {
    async getSession() { return value; },
    async revokeSession() {},
    async revokeOtherSessions() { return 0; },
    async beginStepUp() {
      return {
        challengeId: "00000000-0000-4000-8000-000000000003",
        expiresAt: new Date(now + 60_000).toISOString(),
        method: "passkey",
        challenge: "dGVzdC1jaGFsbGVuZ2U",
        rpId: "getdone.test",
        allowCredentialIds: ["Y3JlZGVudGlhbC0x"],
        userVerification: "required"
      };
    },
    async verifyStepUp() { return { session: session(), token: "rotated-session-token" }; }
  };
}

describe("server request auth guard", () => {
  it("authorizes an active normal session", async () => {
    const result = await authorizeRequest(adapter(session()), new Request("https://getdone.test"));
    expect(result.requirement).toBe("session");
    expect(result.session.userId).toBe("user-1");
  });

  it("requires independent fresh step-up for high-risk requests", async () => {
    await expect(authorizeRequest(
      adapter(session()),
      new Request("https://getdone.test"),
      "fresh-step-up"
    )).rejects.toThrow(/step-up/i);

    const elevated = session({ stepUpAuthenticatedAt: new Date(now - 30_000).toISOString() });
    await expect(authorizeRequest(
      adapter(elevated),
      new Request("https://getdone.test"),
      "fresh-step-up"
    )).resolves.toMatchObject({ requirement: "fresh-step-up" });
  });

  it("fails closed when the adapter returns no session", async () => {
    await expect(authorizeRequest(
      adapter(null),
      new Request("https://getdone.test")
    )).rejects.toThrow(/active session/i);
  });
});
