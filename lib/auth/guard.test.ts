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
    async beginStepUp() {
      return { challengeId: "challenge-1", expiresAt: new Date(now + 60_000).toISOString(), method: "passkey" };
    },
    async verifyStepUp() { return session(); }
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
