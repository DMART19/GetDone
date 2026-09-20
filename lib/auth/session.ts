import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthSession } from "@/lib/auth/contracts";

function toEpoch(value: string) {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new ControlPlaneError("UNAUTHENTICATED", "Invalid session timestamp");
  return result;
}

export function isSessionActive(session: AuthSession | null, now = Date.now()) {
  if (!session) return false;
  if (session.revokedAt) return false;
  return toEpoch(session.expiresAt) > now;
}

export function requireActiveSession(session: AuthSession | null, now = Date.now()): AuthSession {
  if (!isSessionActive(session, now)) {
    throw new ControlPlaneError("UNAUTHENTICATED", "An active session is required");
  }
  return session as AuthSession;
}

export function hasFreshStepUp(session: AuthSession, maxAgeMs = 5 * 60_000, now = Date.now()) {
  if (!session.stepUpAuthenticatedAt) return false;
  const stepUpAt = toEpoch(session.stepUpAuthenticatedAt);
  return stepUpAt <= now && now - stepUpAt <= maxAgeMs;
}

export function requireFreshStepUp(session: AuthSession, maxAgeMs = 5 * 60_000, now = Date.now()) {
  requireActiveSession(session, now);
  if (!hasFreshStepUp(session, maxAgeMs, now)) {
    throw new ControlPlaneError("FORBIDDEN", "Fresh step-up authentication is required");
  }
  return session;
}
