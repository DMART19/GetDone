import {
  createHash,
  generateKeyPairSync,
  sign
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyWebAuthnAssertion,
  webAuthnChallengeHash
} from "@/lib/auth/webauthn";

function b64(value: Buffer) {
  return value.toString("base64url");
}

function fixture(options: {
  origin?: string;
  rpId?: string;
  flags?: number;
  counter?: number;
  challenge?: string;
  signWithWrongKey?: boolean;
  storedCounter?: number;
} = {}) {
  const rpId = options.rpId ?? "getdone.test";
  const origin = options.origin ?? "https://getdone.test";
  const challenge = options.challenge ?? "fixture-challenge-value";
  const credentialId = "Y3JlZGVudGlhbC0x";
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1"
  });
  const wrong = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const clientData = Buffer.from(JSON.stringify({
    type: "webauthn.get",
    challenge,
    origin,
    crossOrigin: false
  }));
  const authenticatorData = Buffer.alloc(37);
  createHash("sha256").update(rpId).digest().copy(authenticatorData, 0);
  authenticatorData[32] = options.flags ?? 0x05;
  authenticatorData.writeUInt32BE(options.counter ?? 1, 33);
  const signedData = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientData).digest()
  ]);
  const signature = sign(
    "sha256",
    signedData,
    options.signWithWrongKey ? wrong.privateKey : privateKey
  );

  return {
    input: {
      assertion: {
        credentialId,
        clientDataJSON: b64(clientData),
        authenticatorData: b64(authenticatorData),
        signature: b64(signature)
      },
      expectedChallengeHash: webAuthnChallengeHash(challenge),
      rpId,
      allowedOrigins: ["https://getdone.test"],
      requireUserVerification: true,
      credential: {
        credentialId,
        userId: "user-a",
        publicKeyPem: publicKey.export({
          type: "spki",
          format: "pem"
        }).toString(),
        algorithm: "ES256" as const,
        signCount: options.storedCounter ?? 0
      }
    }
  };
}

describe("WebAuthn assertion verification", () => {
  it("verifies challenge, origin, RP ID, user verification, signature, and counter", () => {
    const { input } = fixture({ counter: 7, storedCounter: 6 });
    expect(verifyWebAuthnAssertion(input)).toMatchObject({
      credentialId: "Y3JlZGVudGlhbC0x",
      origin: "https://getdone.test",
      userVerified: true,
      newSignCount: 7
    });
  });

  it("rejects the wrong origin", () => {
    const { input } = fixture({ origin: "https://evil.example" });
    expect(() => verifyWebAuthnAssertion(input)).toThrow(/origin is not allowed/i);
  });

  it("rejects an RP ID hash mismatch", () => {
    const { input } = fixture();
    expect(() => verifyWebAuthnAssertion({
      ...input,
      rpId: "other.getdone.test"
    })).toThrow(/RP ID hash/i);
  });

  it("requires authenticator user verification", () => {
    const { input } = fixture({ flags: 0x01 });
    expect(() => verifyWebAuthnAssertion(input)).toThrow(/user verification/i);
  });

  it("rejects a bad cryptographic signature", () => {
    const { input } = fixture({ signWithWrongKey: true });
    expect(() => verifyWebAuthnAssertion(input)).toThrow(/signature is invalid/i);
  });

  it("rejects non-advancing signature counters when the authenticator uses counters", () => {
    const { input } = fixture({ counter: 9, storedCounter: 9 });
    expect(() => verifyWebAuthnAssertion(input)).toThrow(/counter did not advance/i);
  });

  it("allows authenticators that consistently report a zero counter", () => {
    const { input } = fixture({ counter: 0, storedCounter: 0 });
    expect(verifyWebAuthnAssertion(input).newSignCount).toBe(0);
  });

  it("rejects a challenge mismatch", () => {
    const { input } = fixture();
    expect(() => verifyWebAuthnAssertion({
      ...input,
      expectedChallengeHash: webAuthnChallengeHash("different-challenge")
    })).toThrow(/challenge does not match/i);
  });
});
