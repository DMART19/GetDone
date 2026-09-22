import { afterEach, describe, expect, it, vi } from "vitest";
import { getPasskeyAssertion } from "@/lib/auth/webauthn-browser";

class MockAuthenticatorAssertionResponse {
  constructor(
    readonly clientDataJSON: ArrayBuffer,
    readonly authenticatorData: ArrayBuffer,
    readonly signature: ArrayBuffer,
    readonly userHandle: ArrayBuffer | null
  ) {}
}

class MockPublicKeyCredential {
  constructor(
    readonly id: string,
    readonly response: unknown
  ) {}
}

const challenge = {
  challengeId: "challenge-a",
  challenge: "AQI",
  rpId: "getdone.test",
  allowCredentialIds: ["AwQ"],
  userVerification: "required" as const
};

function installBrowser(get: ReturnType<typeof vi.fn>) {
  Object.defineProperty(globalThis, "AuthenticatorAssertionResponse", {
    configurable: true,
    value: MockAuthenticatorAssertionResponse
  });
  Object.defineProperty(globalThis, "PublicKeyCredential", {
    configurable: true,
    value: MockPublicKeyCredential
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { credentials: { get } }
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { PublicKeyCredential: MockPublicKeyCredential }
  });
}

afterEach(() => {
  for (const key of [
    "AuthenticatorAssertionResponse",
    "PublicKeyCredential",
    "navigator",
    "window"
  ]) {
    Reflect.deleteProperty(globalThis, key);
  }
});

describe("browser passkey assertion adapter", () => {
  it("converts browser credential bytes to the server WebAuthn envelope", async () => {
    const response = new MockAuthenticatorAssertionResponse(
      Uint8Array.from([5, 6]).buffer,
      Uint8Array.from([7, 8]).buffer,
      Uint8Array.from([9, 10]).buffer,
      null
    );
    const get = vi.fn().mockResolvedValue(
      new MockPublicKeyCredential("credential-a", response)
    );
    installBrowser(get);

    await expect(getPasskeyAssertion(challenge)).resolves.toEqual({
      id: "credential-a",
      type: "public-key",
      response: {
        clientDataJSON: "BQY",
        authenticatorData: "Bwg",
        signature: "CQo",
        userHandle: null
      }
    });

    expect(get).toHaveBeenCalledTimes(1);
    const options = get.mock.calls[0][0].publicKey;
    expect(options.rpId).toBe("getdone.test");
    expect(options.userVerification).toBe("required");
    expect(new Uint8Array(options.challenge)).toEqual(Uint8Array.from([1, 2]));
    expect(new Uint8Array(options.allowCredentials[0].id))
      .toEqual(Uint8Array.from([3, 4]));
  });

  it("fails closed when passkeys are unsupported or browser output is unexpected", async () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {}
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {}
    });
    await expect(getPasskeyAssertion(challenge))
      .rejects.toThrow(/does not support passkeys/i);

    const getWrongCredential = vi.fn().mockResolvedValue({});
    installBrowser(getWrongCredential);
    await expect(getPasskeyAssertion(challenge))
      .rejects.toThrow(/cancelled or unavailable/i);

    const getWrongResponse = vi.fn().mockResolvedValue(
      new MockPublicKeyCredential("credential-a", {})
    );
    installBrowser(getWrongResponse);
    await expect(getPasskeyAssertion(challenge))
      .rejects.toThrow(/unexpected credential response/i);
  });
});
