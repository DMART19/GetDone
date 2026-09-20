import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { ResourceType } from "@/lib/domain/resources";

export type ResourceEnrollmentState =
  | "identify"
  | "create-enrollment"
  | "owner-action"
  | "authenticate"
  | "discover"
  | "profile"
  | "validate"
  | "test"
  | "register"
  | "ready"
  | "cancelled"
  | "failed"
  | "expired";

export interface ResourceEnrollmentRecord {
  id: string;
  portfolioId: string;
  companyId: string;
  state: ResourceEnrollmentState;
  requestedType: ResourceType;
  requestedResourceId?: string;
  environmentPermissions: readonly ("development" | "staging" | "production")[];
  adapterPath: string;
  ownerActionRequired: boolean;
  ownerActionEvidenceIds: readonly string[];
  tokenHash: string;
  tokenConsumedAt?: string;
  challengeHash: string;
  challengeConsumedAt?: string;
  evidenceIds: readonly string[];
  attempt: number;
  expiresAt: string;
  version: number;
  updatedAt: string;
}

export function hashEnrollmentSecret(kind: "token" | "challenge", secret: string) {
  if (!secret || secret.length < 12) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      `Enrollment ${kind} must contain at least 12 characters`
    );
  }
  return sha256Hex({ kind, secret });
}

export function assertEnrollmentNotExpired(
  record: ResourceEnrollmentRecord,
  now = Date.now()
) {
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new ControlPlaneError("FORBIDDEN", "Resource enrollment has expired");
  }
  return record;
}
