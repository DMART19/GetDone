import { describe, expect, it } from "vitest";
import { hasFreshStepUp, isSessionActive, requireActiveSession } from "@/lib/auth/session";
import type { AuthSession } from "@/lib/auth/contracts";

const now = Date.parse("2026-09-20T16:00:00Z");

function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    sessionId: "session-1",
    userId: "user-1",
    issuedAt: "2026-09-20T15:00:00Z",
    authenticatedAt: "2026-09-20T15:00:00Z",
    expiresAt: "2026-09-20T17:00:00Z",
    ...overrides
  };
}

describe("session authority", () => {
  it("rejects expired and revoked sessions", () => {
    expect(isSessionActive(session({ expiresAt: "2026-09-20T15:59:59Z" }), now)).toBe(false);
    expect(isSessionActive(session({ revokedAt: "2026-09-20T15:30:00Z" }), now)).toBe(false);
  });

  it("requires a real active session", () => {
    expect(() => requireActiveSession(null, now)).toThrow();
    expect(requireActiveSession(session(), now).userId).toBe("user-1");
  });

  it("keeps step-up separate from normal login", () => {
    expect(hasFreshStepUp(session(), 300_000, now)).toBe(false);
    expect(hasFreshStepUp(session({ stepUpAuthenticatedAt: "2026-09-20T15:58:00Z" }), 300_000, now)).toBe(true);
  });
});
