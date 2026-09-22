import { describe, expect, it } from "vitest";
import { readWebAuthnServerConfig } from "@/lib/auth/webauthn-config";

describe("WebAuthn server configuration", () => {
  it("accepts exact HTTPS origins under the RP ID", () => {
    expect(readWebAuthnServerConfig({
      GETDONE_WEBAUTHN_RP_ID: "getdone.test",
      GETDONE_WEBAUTHN_ORIGINS: "[\"https://getdone.test\",\"https://app.getdone.test\"]"
    })).toMatchObject({
      rpId: "getdone.test",
      allowedOrigins: ["https://getdone.test", "https://app.getdone.test"]
    });
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
});
