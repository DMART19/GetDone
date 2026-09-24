import { describe, expect, it } from "vitest";
import { readWebAuthnServerConfig } from "@/lib/auth/webauthn-config";

describe("WebAuthn server configuration", () => {
  it("accepts exact HTTPS origins under the RP ID", () => {
    expect(readWebAuthnServerConfig({
      GETDONE_WEBAUTHN_RP_ID: "getdone.test",
      GETDONE_WEBAUTHN_ORIGINS: "[\"https://getdone.test\",\"https://app.getdone.test\"]"
    })).toMatchObject({
      rpId: "getdone.test",
      allowedOrigins: ["https://getdone.test", "https://app.getdone.test"],
      cookieName: "getdone_session",
      stepUpTtlSeconds: 300,
      signInChallengeTtlSeconds: 300,
      sessionTtlSeconds: 86_400,
      secureCookie: true
    });
  });

  it("accepts explicit cookie and positive TTL configuration", () => {
    expect(readWebAuthnServerConfig({
      GETDONE_WEBAUTHN_RP_ID: "getdone.test",
      GETDONE_WEBAUTHN_ORIGINS: "https://app.getdone.test",
      GETDONE_AUTH_COOKIE_NAME: "owner_session",
      GETDONE_STEP_UP_TTL_SECONDS: "120",
      GETDONE_SIGN_IN_CHALLENGE_TTL_SECONDS: "180",
      GETDONE_SESSION_TTL_SECONDS: "7200"
    })).toMatchObject({
      cookieName: "owner_session",
      stepUpTtlSeconds: 120,
      signInChallengeTtlSeconds: 180,
      sessionTtlSeconds: 7200
    });
  });

  it("rejects missing or malformed RP configuration", () => {
    expect(() => readWebAuthnServerConfig({
      GETDONE_WEBAUTHN_ORIGINS: "https://getdone.test"
    })).toThrow(/RP_ID is required/i);
    expect(() => readWebAuthnServerConfig({
      GETDONE_WEBAUTHN_RP_ID: "bad rp",
      GETDONE_WEBAUTHN_ORIGINS: "https://getdone.test"
    })).toThrow(/RP_ID is required/i);
  });

  it("rejects missing, empty, malformed, or invalid origin configuration", () => {
    expect(() => readWebAuthnServerConfig({
      GETDONE_WEBAUTHN_RP_ID: "getdone.test"
    })).toThrow(/ORIGINS is required/i);

    expect(() => readWebAuthnServerConfig({
      GETDONE_WEBAUTHN_RP_ID: "getdone.test",
      GETDONE_WEBAUTHN_ORIGINS: "[]"
    })).toThrow(/At least one WebAuthn origin/i);

    expect(() => readWebAuthnServerConfig({
      GETDONE_WEBAUTHN_RP_ID: "getdone.test",
      GETDONE_WEBAUTHN_ORIGINS: "[\"https://getdone.test\",7]"
    })).toThrow(/JSON string array/i);

    expect(() => readWebAuthnServerConfig({
      GETDONE_WEBAUTHN_RP_ID: "getdone.test",
      GETDONE_WEBAUTHN_ORIGINS: "not a url"
    })).toThrow(/valid URLs/i);
  });

  it("rejects insecure or non-origin URL forms", () => {
    expect(() => readWebAuthnServerConfig({
      GETDONE_WEBAUTHN_RP_ID: "getdone.test",
      GETDONE_WEBAUTHN_ORIGINS: "http://getdone.test"
    })).toThrow(/exact HTTPS origins/i);

    expect(() => readWebAuthnServerConfig({
      GETDONE_WEBAUTHN_RP_ID: "getdone.test",
      GETDONE_WEBAUTHN_ORIGINS: "https://getdone.test/path"
    })).toThrow(/exact HTTPS origins/i);
  });

  it("rejects unrelated origins even when explicitly listed", () => {
    expect(() => readWebAuthnServerConfig({
      GETDONE_WEBAUTHN_RP_ID: "getdone.test",
      GETDONE_WEBAUTHN_ORIGINS: "https://evil.example"
    })).toThrow(/RP ID/i);
  });

  it("permits HTTP only for localhost development ceremonies", () => {
    expect(readWebAuthnServerConfig({
      GETDONE_WEBAUTHN_RP_ID: "localhost",
      GETDONE_WEBAUTHN_ORIGINS: "http://localhost"
    }).allowedOrigins).toEqual(["http://localhost"]);
  });

  it("allows an explicit insecure cookie only as runtime configuration for localhost staging tests", () => {
    expect(readWebAuthnServerConfig({
      GETDONE_WEBAUTHN_RP_ID: "localhost",
      GETDONE_WEBAUTHN_ORIGINS: "http://localhost:3200",
      GETDONE_AUTH_COOKIE_SECURE: "false"
    }).secureCookie).toBe(false);
  });

  it("rejects non-positive and non-integer TTLs", () => {
    for (const [name, value] of [
      ["GETDONE_STEP_UP_TTL_SECONDS", "0"],
      ["GETDONE_SIGN_IN_CHALLENGE_TTL_SECONDS", "-1"],
      ["GETDONE_SESSION_TTL_SECONDS", "1.5"]
    ] as const) {
      expect(() => readWebAuthnServerConfig({
        GETDONE_WEBAUTHN_RP_ID: "getdone.test",
        GETDONE_WEBAUTHN_ORIGINS: "https://getdone.test",
        [name]: value
      })).toThrow(/positive integer/i);
    }
  });
});
