import { describe, expect, it } from "vitest";
import {
  serializeClearedSessionCookie,
  serializeSessionCookie
} from "@/lib/auth/cookies";
import type { WebAuthnServerConfig } from "@/lib/auth/webauthn-config";

const config: WebAuthnServerConfig = {
  rpId: "getdone.example",
  allowedOrigins: ["https://app.getdone.example"],
  cookieName: "getdone_session",
  stepUpTtlSeconds: 300,
  signInChallengeTtlSeconds: 300,
  sessionTtlSeconds: 3600,
  secureCookie: true
};

describe("session cookie hardening", () => {
  it("uses Secure, HttpOnly, Strict SameSite, root Path, and no Domain attribute", () => {
    const value = serializeSessionCookie(
      config,
      "opaque-token",
      new Date(Date.now() + 60_000).toISOString()
    );
    expect(value).toContain("getdone_session=opaque-token");
    expect(value).toContain("Path=/");
    expect(value).toContain("HttpOnly");
    expect(value).toContain("Secure");
    expect(value).toContain("SameSite=Strict");
    expect(value).toContain("Priority=High");
    expect(value).not.toContain("Domain=");
  });

  it("clears the same hardened cookie on logout", () => {
    const value = serializeClearedSessionCookie(config);
    expect(value).toContain("getdone_session=");
    expect(value).toContain("Max-Age=0");
    expect(value).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(value).toContain("HttpOnly");
    expect(value).toContain("Secure");
    expect(value).toContain("SameSite=Strict");
  });
});
