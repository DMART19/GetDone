import { ControlPlaneError } from "@/lib/control-plane/errors";

export interface WebAuthnServerConfig {
  rpId: string;
  allowedOrigins: readonly string[];
  cookieName: string;
  stepUpTtlSeconds: number;
  signInChallengeTtlSeconds: number;
  sessionTtlSeconds: number;
}

function positiveInt(value: string | undefined, fallback: number, name: string) {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ControlPlaneError("UNAVAILABLE", `${name} must be a positive integer`);
  }
  return parsed;
}

function parseOrigins(value: string | undefined) {
  if (!value?.trim()) {
    throw new ControlPlaneError("UNAVAILABLE", "GETDONE_WEBAUTHN_ORIGINS is required");
  }
  const raw = value.trim();
  let origins: string[];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
        throw new Error();
      }
      origins = parsed;
    } catch {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "GETDONE_WEBAUTHN_ORIGINS must be a JSON string array or comma-separated list"
      );
    }
  } else {
    origins = raw.split(",");
  }

  const normalized = [...new Set(origins.map((origin) => origin.trim()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new ControlPlaneError("UNAVAILABLE", "At least one WebAuthn origin is required");
  }
  for (const origin of normalized) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new ControlPlaneError("UNAVAILABLE", "WebAuthn origins must be valid URLs");
    }
    if (url.origin !== origin || (url.protocol !== "https:" && url.hostname !== "localhost")) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "WebAuthn origins must be exact HTTPS origins (localhost may use HTTP)"
      );
    }
  }
  return Object.freeze(normalized);
}

export function readWebAuthnServerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): WebAuthnServerConfig {
  const rpId = env.GETDONE_WEBAUTHN_RP_ID?.trim();
  if (!rpId || !/^[A-Za-z0-9.-]+$/.test(rpId)) {
    throw new ControlPlaneError("UNAVAILABLE", "GETDONE_WEBAUTHN_RP_ID is required");
  }
  return Object.freeze({
    rpId,
    allowedOrigins: parseOrigins(env.GETDONE_WEBAUTHN_ORIGINS),
    cookieName: env.GETDONE_AUTH_COOKIE_NAME?.trim() || "getdone_session",
    stepUpTtlSeconds: positiveInt(
      env.GETDONE_STEP_UP_TTL_SECONDS,
      300,
      "GETDONE_STEP_UP_TTL_SECONDS"
    ),
    signInChallengeTtlSeconds: positiveInt(
      env.GETDONE_SIGN_IN_CHALLENGE_TTL_SECONDS,
      300,
      "GETDONE_SIGN_IN_CHALLENGE_TTL_SECONDS"
    ),
    sessionTtlSeconds: positiveInt(
      env.GETDONE_SESSION_TTL_SECONDS,
      86_400,
      "GETDONE_SESSION_TTL_SECONDS"
    )
  });
}
