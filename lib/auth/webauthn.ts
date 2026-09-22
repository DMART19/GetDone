import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature
} from "node:crypto";
import { ControlPlaneError } from "@/lib/control-plane/errors";

export type WebAuthnAlgorithm = "ES256" | "RS256";

export interface WebAuthnCredentialRecord {
  credentialId: string;
  userId: string;
  userHandle?: string;
  publicKeyPem: string;
  algorithm: WebAuthnAlgorithm;
  signCount: number;
}

export interface WebAuthnAssertionResponse {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle?: string | null;
}

export interface WebAuthnVerificationInput {
  assertion: WebAuthnAssertionResponse;
  expectedChallengeHash: string;
  rpId: string;
  allowedOrigins: readonly string[];
  requireUserVerification: boolean;
  credential: WebAuthnCredentialRecord;
}

export interface VerifiedWebAuthnAssertion {
  credentialId: string;
  origin: string;
  userVerified: boolean;
  newSignCount: number;
}

function decodeBase64Url(value: string, label: string, maxBytes: number) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be base64url`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} size is invalid`);
  }
  return bytes;
}

function hash(value: Buffer | string) {
  return createHash("sha256").update(value).digest();
}

function assertDigestHex(actual: Buffer, expectedHex: string, message: string) {
  if (!/^[a-f0-9]{64}$/i.test(expectedHex)) {
    throw new ControlPlaneError("FORBIDDEN", message);
  }
  const expected = Buffer.from(expectedHex, "hex");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new ControlPlaneError("FORBIDDEN", message);
  }
}

export function generateWebAuthnChallenge() {
  return randomBytes(32).toString("base64url");
}

export function webAuthnChallengeHash(challenge: string) {
  return createHash("sha256").update(challenge).digest("hex");
}

export function parseWebAuthnAssertion(value: unknown): WebAuthnAssertionResponse {
  if (!value || typeof value !== "object") {
    throw new ControlPlaneError("VALIDATION_FAILED", "WebAuthn assertion is required");
  }
  const record = value as Record<string, unknown>;
  const response = (
    record.response && typeof record.response === "object"
      ? record.response
      : record
  ) as Record<string, unknown>;

  const credentialId = typeof record.id === "string"
    ? record.id
    : typeof record.credentialId === "string"
      ? record.credentialId
      : "";
  const clientDataJSON = typeof response.clientDataJSON === "string"
    ? response.clientDataJSON
    : "";
  const authenticatorData = typeof response.authenticatorData === "string"
    ? response.authenticatorData
    : "";
  const signature = typeof response.signature === "string"
    ? response.signature
    : "";
  const userHandle = response.userHandle === null || typeof response.userHandle === "string"
    ? response.userHandle as string | null
    : undefined;

  if (!credentialId || credentialId.length > 2048) {
    throw new ControlPlaneError("VALIDATION_FAILED", "WebAuthn credential id is required");
  }

  return {
    credentialId,
    clientDataJSON,
    authenticatorData,
    signature,
    userHandle
  };
}

export function verifyWebAuthnAssertion(
  input: WebAuthnVerificationInput
): VerifiedWebAuthnAssertion {
  const { assertion, credential } = input;
  if (assertion.credentialId !== credential.credentialId) {
    throw new ControlPlaneError("FORBIDDEN", "WebAuthn credential does not match the authoritative credential");
  }

  const clientDataBytes = decodeBase64Url(
    assertion.clientDataJSON,
    "WebAuthn clientDataJSON",
    16 * 1024
  );
  let clientData: {
    type?: unknown;
    challenge?: unknown;
    origin?: unknown;
    crossOrigin?: unknown;
  };
  try {
    clientData = JSON.parse(clientDataBytes.toString("utf8"));
  } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", "WebAuthn clientDataJSON is invalid");
  }

  if (clientData.type !== "webauthn.get") {
    throw new ControlPlaneError("FORBIDDEN", "WebAuthn ceremony type is invalid");
  }
  if (typeof clientData.challenge !== "string") {
    throw new ControlPlaneError("FORBIDDEN", "WebAuthn challenge is missing");
  }
  assertDigestHex(
    hash(clientData.challenge),
    input.expectedChallengeHash,
    "WebAuthn challenge does not match the authoritative ceremony"
  );

  if (
    typeof clientData.origin !== "string"
    || !input.allowedOrigins.includes(clientData.origin)
    || clientData.crossOrigin === true
  ) {
    throw new ControlPlaneError("FORBIDDEN", "WebAuthn origin is not allowed");
  }

  const authenticatorData = decodeBase64Url(
    assertion.authenticatorData,
    "WebAuthn authenticatorData",
    4096
  );
  if (authenticatorData.byteLength < 37) {
    throw new ControlPlaneError("VALIDATION_FAILED", "WebAuthn authenticatorData is truncated");
  }

  assertDigestHex(
    authenticatorData.subarray(0, 32),
    createHash("sha256").update(input.rpId).digest("hex"),
    "WebAuthn RP ID hash does not match"
  );

  const flags = authenticatorData[32];
  const userPresent = (flags & 0x01) !== 0;
  const userVerified = (flags & 0x04) !== 0;
  if (!userPresent) {
    throw new ControlPlaneError("FORBIDDEN", "WebAuthn user presence is required");
  }
  if (input.requireUserVerification && !userVerified) {
    throw new ControlPlaneError("FORBIDDEN", "WebAuthn user verification is required");
  }

  if (
    credential.userHandle
    && assertion.userHandle
    && assertion.userHandle !== credential.userHandle
  ) {
    throw new ControlPlaneError("FORBIDDEN", "WebAuthn user handle does not match");
  }

  const newSignCount = authenticatorData.readUInt32BE(33);
  if (
    (credential.signCount > 0 || newSignCount > 0)
    && newSignCount <= credential.signCount
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "WebAuthn signature counter did not advance; possible replay or cloned credential"
    );
  }

  const signature = decodeBase64Url(assertion.signature, "WebAuthn signature", 4096);
  const signedData = Buffer.concat([
    authenticatorData,
    hash(clientDataBytes)
  ]);

  let key;
  try {
    key = createPublicKey(credential.publicKeyPem);
  } catch {
    throw new ControlPlaneError("UNAVAILABLE", "Stored WebAuthn public key is invalid");
  }

  if (
    (credential.algorithm === "ES256" && key.asymmetricKeyType !== "ec")
    || (credential.algorithm === "RS256" && key.asymmetricKeyType !== "rsa")
  ) {
    throw new ControlPlaneError("FORBIDDEN", "WebAuthn credential algorithm does not match its public key");
  }

  if (!verifySignature("sha256", signedData, key, signature)) {
    throw new ControlPlaneError("FORBIDDEN", "WebAuthn assertion signature is invalid");
  }

  return Object.freeze({
    credentialId: credential.credentialId,
    origin: clientData.origin,
    userVerified,
    newSignCount
  });
}


export interface WebAuthnCeremony {
  id: string;
  type: "registration" | "authentication";
  rpId: string;
  allowedOrigins: readonly string[];
  challengeHash: string;
  issuedAt: string;
  expiresAt: string;
  requireUserVerification: boolean;
}

export interface WebAuthnResponseEnvelope {
  ceremonyId: string;
  rpId: string;
  origin: string;
  credentialId: string;
  userVerified: boolean;
}

function parseCeremonyTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

/**
 * Lightweight ceremony-scope guard retained for mobile/deep-link contract checks.
 * Cryptographic production authentication must use verifyWebAuthnAssertion().
 */
export function assertWebAuthnCeremony(
  ceremony: WebAuthnCeremony,
  response: WebAuthnResponseEnvelope,
  now = Date.now()
) {
  const issuedAt = parseCeremonyTime(ceremony.issuedAt, "WebAuthn issuedAt");
  const expiresAt = parseCeremonyTime(ceremony.expiresAt, "WebAuthn expiresAt");
  if (issuedAt >= expiresAt || issuedAt > now || expiresAt <= now) {
    throw new ControlPlaneError("FORBIDDEN", "WebAuthn ceremony is expired or not active");
  }
  if (
    response.ceremonyId !== ceremony.id
    || response.rpId !== ceremony.rpId
    || !ceremony.allowedOrigins.includes(response.origin)
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "WebAuthn response is outside the ceremony origin/RP scope"
    );
  }
  if (!response.credentialId) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "WebAuthn credential identity is required"
    );
  }
  if (ceremony.requireUserVerification && !response.userVerified) {
    throw new ControlPlaneError("FORBIDDEN", "WebAuthn user verification is required");
  }
  return response;
}
