import type { WebAuthnServerConfig } from "@/lib/auth/webauthn-config";

function maxAgeSeconds(expiresAt: string, now = Date.now()) {
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return 1;
  return Math.max(1, Math.floor((expires - now) / 1000));
}

function securityAttributes(config: WebAuthnServerConfig) {
  return [
    "Path=/",
    "HttpOnly",
    config.secureCookie ? "Secure" : null,
    "SameSite=Strict",
    "Priority=High"
  ].filter(Boolean) as string[];
}

export function serializeSessionCookie(
  config: WebAuthnServerConfig,
  token: string,
  expiresAt: string,
  now = Date.now()
) {
  return [
    `${config.cookieName}=${encodeURIComponent(token)}`,
    ...securityAttributes(config),
    `Max-Age=${maxAgeSeconds(expiresAt, now)}`
  ].join("; ");
}

export function serializeClearedSessionCookie(config: WebAuthnServerConfig) {
  return [
    `${config.cookieName}=`,
    ...securityAttributes(config),
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ].join("; ");
}
