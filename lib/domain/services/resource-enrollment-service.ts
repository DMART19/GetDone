import { createAuditEvent } from "@/lib/domain/audit";
import { commandFingerprint, type AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { claimIdempotency } from "@/lib/domain/idempotency";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import {
  executeTransitionCommand,
  type EntityStore
} from "@/lib/domain/services/common";
import {
  assertEnrollmentNotExpired,
  hashEnrollmentSecret,
  type ResourceEnrollmentRecord
} from "@/lib/domain/enrollment";
import type { ResourceType } from "@/lib/domain/resources";

export interface ResourceEnrollmentStore extends EntityStore<ResourceEnrollmentRecord> {
  create(record: ResourceEnrollmentRecord): Promise<void>;
}

export interface ResourceEnrollmentStores {
  enrollments: ResourceEnrollmentStore;
}

export interface IdentifyResourceInput {
  id: string;
  requestedType: ResourceType;
  requestedResourceId?: string;
  environmentPermissions: ResourceEnrollmentRecord["environmentPermissions"];
  adapterPath: string;
  ownerActionRequired: boolean;
  token: string;
  challenge: string;
  expiresAt: string;
  identifiedAt?: string;
}

function validFutureExpiry(expiresAt: string, now: number) {
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed) || parsed <= now) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Enrollment expiry must be in the future");
  }
}

function requireEvidence(evidenceIds: readonly string[], stage: string) {
  if (evidenceIds.length === 0) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      `Enrollment stage ${stage} requires verification evidence`
    );
  }
}

export class ResourceEnrollmentService {
  constructor(private readonly transactions: ControlPlaneTransactionManager<ResourceEnrollmentStores>) {}

  identify(input: IdentifyResourceInput, command: AuthoritativeCommandEnvelope) {
    if (!input.id || !input.adapterPath || input.environmentPermissions.length === 0) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Enrollment identification requires id, adapter path, and environment scope"
      );
    }

    const identifiedAt = input.identifiedAt ?? new Date().toISOString();
    const now = Date.parse(identifiedAt);
    if (!Number.isFinite(now)) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Enrollment identification time is invalid");
    }
    validFutureExpiry(input.expiresAt, now);

    const tokenHash = hashEnrollmentSecret("token", input.token);
    const challengeHash = hashEnrollmentSecret("challenge", input.challenge);
    const fingerprint = commandFingerprint(command);

    return this.transactions.run(async (transaction) => {
      const claim = await claimIdempotency<ResourceEnrollmentRecord>(
        transaction.idempotency,
        command.idempotencyKey,
        fingerprint,
        new Date(identifiedAt)
      );
      if (claim.state === "COMPLETED" && claim.record.result) return claim.record.result;
      if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
        throw new ControlPlaneError("CONFLICT", "Enrollment identification is not retryable yet");
      }

      const record: ResourceEnrollmentRecord = Object.freeze({
        id: input.id,
        portfolioId: command.scope.portfolioId,
        companyId: command.scope.companyId,
        state: "identify",
        requestedType: input.requestedType,
        requestedResourceId: input.requestedResourceId,
        environmentPermissions: Object.freeze([...input.environmentPermissions]),
        adapterPath: input.adapterPath,
        ownerActionRequired: input.ownerActionRequired,
        ownerActionEvidenceIds: Object.freeze([]),
        tokenHash,
        challengeHash,
        evidenceIds: Object.freeze([]),
        attempt: 1,
        expiresAt: input.expiresAt,
        version: 1,
        updatedAt: identifiedAt
      });

      await transaction.stores.enrollments.create(record);
      await transaction.audit.append(createAuditEvent({
        correlationId: command.correlationId,
        eventType: "enrollment.identify",
        actor: command.actor,
        scope: {
          userId: command.scope.userId,
          portfolioId: command.scope.portfolioId,
          companyId: command.scope.companyId,
          resourceId: input.requestedResourceId
        },
        environment: command.environment,
        entityType: "enrollment",
        entityId: record.id,
        newState: "identify",
        provenance: command.provenance,
        metadata: {
          requestedType: record.requestedType,
          adapterPath: record.adapterPath,
          ownerActionRequired: record.ownerActionRequired
        }
      }));
      await transaction.idempotency.complete(
        command.idempotencyKey,
        fingerprint,
        record,
        identifiedAt
      );
      return record;
    });
  }

  createEnrollment(
    id: string,
    command: AuthoritativeCommandEnvelope,
    token: string,
    now = Date.now()
  ) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "enrollment",
      entityId: id,
      to: "create-enrollment",
      command,
      triggeringEvent: "enrollment-token-consumed",
      beforeTransition: (current) => {
        assertEnrollmentNotExpired(current, now);
        if (current.tokenConsumedAt) {
          throw new ControlPlaneError("FORBIDDEN", "Enrollment token has already been consumed");
        }
        if (hashEnrollmentSecret("token", token) !== current.tokenHash) {
          throw new ControlPlaneError("FORBIDDEN", "Enrollment token is invalid");
        }
      },
      patch: () => ({ tokenConsumedAt: new Date(now).toISOString() })
    });
  }

  completeOwnerAction(
    id: string,
    command: AuthoritativeCommandEnvelope,
    evidenceIds: readonly string[] = [],
    now = Date.now()
  ) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "enrollment",
      entityId: id,
      to: "owner-action",
      command,
      triggeringEvent: "enrollment-owner-action-completed",
      beforeTransition: (current) => {
        assertEnrollmentNotExpired(current, now);
        if (current.ownerActionRequired) requireEvidence(evidenceIds, "owner-action");
      },
      patch: () => ({ ownerActionEvidenceIds: Object.freeze([...evidenceIds]) }),
      metadata: () => ({ evidenceCount: evidenceIds.length })
    });
  }

  authenticate(
    id: string,
    command: AuthoritativeCommandEnvelope,
    challenge: string,
    evidenceIds: readonly string[],
    now = Date.now()
  ) {
    requireEvidence(evidenceIds, "authenticate");
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "enrollment",
      entityId: id,
      to: "authenticate",
      command,
      triggeringEvent: "enrollment-authenticated",
      beforeTransition: (current) => {
        assertEnrollmentNotExpired(current, now);
        if (current.challengeConsumedAt) {
          throw new ControlPlaneError("FORBIDDEN", "Enrollment challenge has already been consumed");
        }
        if (hashEnrollmentSecret("challenge", challenge) !== current.challengeHash) {
          throw new ControlPlaneError("FORBIDDEN", "Enrollment challenge is invalid");
        }
      },
      patch: (current) => ({
        challengeConsumedAt: new Date(now).toISOString(),
        evidenceIds: Object.freeze([...current.evidenceIds, ...evidenceIds])
      }),
      metadata: () => ({ evidenceCount: evidenceIds.length })
    });
  }

  private advance(
    id: string,
    command: AuthoritativeCommandEnvelope,
    to: "discover" | "profile" | "validate" | "test" | "register" | "ready",
    evidenceIds: readonly string[],
    now = Date.now()
  ) {
    requireEvidence(evidenceIds, to);
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "enrollment",
      entityId: id,
      to,
      command,
      triggeringEvent: `enrollment-${to}`,
      beforeTransition: (current) => {
        assertEnrollmentNotExpired(current, now);
        if (!current.tokenConsumedAt || !current.challengeConsumedAt) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Enrollment cannot advance without consumed token and authenticated challenge"
          );
        }
      },
      patch: (current) => ({
        evidenceIds: Object.freeze([...current.evidenceIds, ...evidenceIds])
      }),
      metadata: () => ({ evidenceCount: evidenceIds.length })
    });
  }

  discover(id: string, command: AuthoritativeCommandEnvelope, evidenceIds: readonly string[], now?: number) {
    return this.advance(id, command, "discover", evidenceIds, now);
  }

  profile(id: string, command: AuthoritativeCommandEnvelope, evidenceIds: readonly string[], now?: number) {
    return this.advance(id, command, "profile", evidenceIds, now);
  }

  validate(id: string, command: AuthoritativeCommandEnvelope, evidenceIds: readonly string[], now?: number) {
    return this.advance(id, command, "validate", evidenceIds, now);
  }

  test(id: string, command: AuthoritativeCommandEnvelope, evidenceIds: readonly string[], now?: number) {
    return this.advance(id, command, "test", evidenceIds, now);
  }

  register(id: string, command: AuthoritativeCommandEnvelope, evidenceIds: readonly string[], now?: number) {
    return this.advance(id, command, "register", evidenceIds, now);
  }

  ready(id: string, command: AuthoritativeCommandEnvelope, registryEvidenceIds: readonly string[], now?: number) {
    return this.advance(id, command, "ready", registryEvidenceIds, now);
  }

  cancel(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "enrollment",
      entityId: id,
      to: "cancelled",
      command,
      triggeringEvent: "enrollment-cancelled"
    });
  }

  fail(id: string, command: AuthoritativeCommandEnvelope, evidenceIds: readonly string[]) {
    requireEvidence(evidenceIds, "failed");
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "enrollment",
      entityId: id,
      to: "failed",
      command,
      triggeringEvent: "enrollment-failed",
      patch: (current) => ({
        evidenceIds: Object.freeze([...current.evidenceIds, ...evidenceIds])
      })
    });
  }

  expire(id: string, command: AuthoritativeCommandEnvelope, now = Date.now()) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "enrollment",
      entityId: id,
      to: "expired",
      command,
      triggeringEvent: "enrollment-expired",
      beforeTransition: (current) => {
        if (Date.parse(current.expiresAt) > now) {
          throw new ControlPlaneError("CONFLICT", "Enrollment has not expired yet");
        }
      }
    });
  }

  restart(
    id: string,
    command: AuthoritativeCommandEnvelope,
    input: { token: string; challenge: string; expiresAt: string },
    now = Date.now()
  ) {
    validFutureExpiry(input.expiresAt, now);
    const tokenHash = hashEnrollmentSecret("token", input.token);
    const challengeHash = hashEnrollmentSecret("challenge", input.challenge);

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "enrollment",
      entityId: id,
      to: "identify",
      command,
      triggeringEvent: "enrollment-restarted",
      patch: (current) => ({
        tokenHash,
        tokenConsumedAt: undefined,
        challengeHash,
        challengeConsumedAt: undefined,
        ownerActionEvidenceIds: Object.freeze([]),
        evidenceIds: Object.freeze([]),
        attempt: current.attempt + 1,
        expiresAt: input.expiresAt
      }),
      metadata: (current) => ({ nextAttempt: current.attempt + 1 })
    });
  }
}
