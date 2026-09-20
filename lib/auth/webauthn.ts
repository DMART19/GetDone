import { ControlPlaneError } from "@/lib/control-plane/errors";

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

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

export function assertWebAuthnCeremony(
  ceremony: WebAuthnCeremony,
  response: WebAuthnResponseEnvelope,
  now = Date.now()
) {
  const issuedAt = parseTime(ceremony.issuedAt, "WebAuthn issuedAt");
  const expiresAt = parseTime(ceremony.expiresAt, "WebAuthn expiresAt");

  if (issuedAt >= expiresAt || issuedAt > now || expiresAt <= now) {
    throw new ControlPlaneError("FORBIDDEN", "WebAuthn ceremony is expired or not active");
  }
  if (
    response.ceremonyId !== ceremony.id
    || response.rpId !== ceremony.rpId
    || !ceremony.allowedOrigins.includes(response.origin)
  ) {
    throw new ControlPlaneError("FORBIDDEN", "WebAuthn response is outside the ceremony origin/RP scope");
  }
  if (!response.credentialId) {
    throw new ControlPlaneError("VALIDATION_FAILED", "WebAuthn credential identity is required");
  }
  if (ceremony.requireUserVerification && !response.userVerified) {
    throw new ControlPlaneError("FORBIDDEN", "WebAuthn user verification is required");
  }

  return response;
}
