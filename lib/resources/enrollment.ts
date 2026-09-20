import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { commandFingerprint } from "@/lib/control-plane/command-envelope";
import { createAuditEvent } from "@/lib/domain/audit";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import { claimIdempotency } from "@/lib/domain/idempotency";
import type { Resource } from "@/lib/domain/resources";
import {
  executeTransitionCommand,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";

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
  | "expired"
  | "failed";

export interface ResourceEnrollmentRecord extends StatefulEntity {
  state: ResourceEnrollmentState;
  requestedType: Resource["type"];
  requestedEnvironments: Resource["environmentPermissions"];
  resourceId?: string;
  ownerActionRequired: boolean;
  ownerActionDescription?: string;
  challengeHash: string;
  challengeIssuedAt: string;
  challengeExpiresAt: string;
  challengeConsumedAt?: string;
  evidenceIds: readonly string[];
  attempt: number;
  failureReason?: string;
}

export interface ResourceEnrollmentStore extends EntityStore<ResourceEnrollmentRecord> {
  create(record: ResourceEnrollmentRecord): Promise<void>;
}

export interface ResourceEnrollmentStores {
  enrollments: ResourceEnrollmentStore;
}

export interface IdentifyResourceEnrollmentInput {
  id: string;
  requestedType: Resource["type"];
  requestedEnvironments: Resource["environmentPermissions"];
  ownerActionRequired: boolean;
  ownerActionDescription?: string;
  challengeToken: string;
  challengeIssuedAt?: string;
  challengeExpiresAt: string;
}

export function hashEnrollmentChallenge(token: string) {
  if (!token) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Enrollment challenge token is required"
    );
  }
  return sha256Hex(token);
}

export function assertEnrollmentChallenge(
  enrollment: ResourceEnrollmentRecord,
  token: string,
  now = Date.now()
) {
  if (enrollment.challengeConsumedAt) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Enrollment challenge has already been consumed"
    );
  }
  if (Date.parse(enrollment.challengeExpiresAt) <= now) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Enrollment challenge has expired"
    );
  }
  if (hashEnrollmentChallenge(token) !== enrollment.challengeHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Enrollment challenge is invalid"
    );
  }
}

export class ResourceEnrollmentService {
  constructor(
    private readonly transactions: ControlPlaneTransactionManager<ResourceEnrollmentStores>
  ) {}

  async identify(
    input: IdentifyResourceEnrollmentInput,
    command: AuthoritativeCommandEnvelope
  ) {
    const issuedAt = input.challengeIssuedAt ?? new Date().toISOString();
    if (
      !Number.isFinite(Date.parse(issuedAt))
      || !Number.isFinite(Date.parse(input.challengeExpiresAt))
      || Date.parse(input.challengeExpiresAt) <= Date.parse(issuedAt)
    ) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Enrollment challenge has an invalid time window"
      );
    }
    if (input.requestedEnvironments.length === 0) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Enrollment requires at least one environment permission"
      );
    }

    const fingerprint = commandFingerprint(command);

    return this.transactions.run(async (transaction) => {
      const claim = await claimIdempotency<ResourceEnrollmentRecord>(
        transaction.idempotency,
        command.idempotencyKey,
        fingerprint,
        new Date(issuedAt)
      );
      if (claim.state === "COMPLETED" && claim.record.result) {
        return claim.record.result;
      }
      if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
        throw new ControlPlaneError(
          "CONFLICT",
          "Enrollment identification is already in progress or previously failed"
        );
      }

      const record: ResourceEnrollmentRecord = Object.freeze({
        id: input.id,
        portfolioId: command.scope.portfolioId,
        companyId: command.scope.companyId,
        state: "identify",
        requestedType: input.requestedType,
        requestedEnvironments: Object.freeze([...input.requestedEnvironments]),
        ownerActionRequired: input.ownerActionRequired,
        ownerActionDescription: input.ownerActionDescription,
        challengeHash: hashEnrollmentChallenge(input.challengeToken),
        challengeIssuedAt: issuedAt,
        challengeExpiresAt: input.challengeExpiresAt,
        evidenceIds: Object.freeze([]),
        attempt: 1,
        version: 1,
        updatedAt: issuedAt
      });

      await transaction.stores.enrollments.create(record);
      await transaction.audit.append(createAuditEvent({
        correlationId: command.correlationId,
        eventType: "resource-enrollment.identified",
        actor: command.actor,
        scope: {
          userId: command.scope.userId,
          portfolioId: command.scope.portfolioId,
          companyId: command.scope.companyId
        },
        environment: command.environment,
        entityType: "resource-enrollment",
        entityId: record.id,
        newState: "identify",
        provenance: command.provenance,
        metadata: {
          commandId: command.commandId,
          requestedType: record.requestedType,
          attempt: record.attempt
        }
      }));
      await transaction.idempotency.complete(
        command.idempotencyKey,
        fingerprint,
        record,
        issuedAt
      );
      return record;
    });
  }

  createEnrollment(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "resource-enrollment",
      entityId: id,
      to: "create-enrollment",
      command,
      triggeringEvent: "resource-enrollment-created"
    });
  }

  recordOwnerAction(
    id: string,
    command: AuthoritativeCommandEnvelope,
    evidenceId: string
  ) {
    if (!evidenceId) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Owner action completion requires evidence"
      );
    }

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "resource-enrollment",
      entityId: id,
      to: "owner-action",
      command,
      triggeringEvent: "resource-enrollment-owner-action",
      beforeTransition: (current) => {
        if (!current.ownerActionRequired) {
          throw new ControlPlaneError(
            "CONFLICT",
            "Enrollment does not require an owner action"
          );
        }
      },
      patch: (current) => ({
        evidenceIds: [...current.evidenceIds, evidenceId]
      }),
      metadata: () => ({ evidenceId })
    });
  }

  authenticate(
    id: string,
    command: AuthoritativeCommandEnvelope,
    challengeToken: string,
    evidenceId: string,
    authenticatedAt = new Date().toISOString()
  ) {
    if (!evidenceId) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Enrollment authentication requires evidence"
      );
    }

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "resource-enrollment",
      entityId: id,
      to: "authenticate",
      command,
      triggeringEvent: "resource-enrollment-authenticated",
      beforeTransition: (current) => {
        if (current.ownerActionRequired && current.state !== "owner-action") {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Required owner action must complete before authentication"
          );
        }
        assertEnrollmentChallenge(
          current,
          challengeToken,
          Date.parse(authenticatedAt)
        );
      },
      patch: (current) => ({
        challengeConsumedAt: authenticatedAt,
        evidenceIds: [...current.evidenceIds, evidenceId]
      }),
      metadata: () => ({ evidenceId })
    });
  }

  discover(id: string, command: AuthoritativeCommandEnvelope, evidenceId: string) {
    return this.advance(id, command, "discover", "resource-enrollment-discovered", evidenceId);
  }

  profile(id: string, command: AuthoritativeCommandEnvelope, evidenceId: string) {
    return this.advance(id, command, "profile", "resource-enrollment-profiled", evidenceId);
  }

  validate(id: string, command: AuthoritativeCommandEnvelope, evidenceId: string) {
    return this.advance(id, command, "validate", "resource-enrollment-validated", evidenceId);
  }

  test(id: string, command: AuthoritativeCommandEnvelope, evidenceId: string) {
    return this.advance(id, command, "test", "resource-enrollment-tested", evidenceId);
  }

  register(
    id: string,
    command: AuthoritativeCommandEnvelope,
    resourceId: string,
    evidenceId: string
  ) {
    if (!resourceId) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Enrollment registration requires an authoritative resource id"
      );
    }
    if (!evidenceId) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Enrollment registration requires evidence"
      );
    }

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "resource-enrollment",
      entityId: id,
      to: "register",
      command,
      triggeringEvent: "resource-enrollment-registered",
      patch: (current) => ({
        resourceId,
        evidenceIds: [...current.evidenceIds, evidenceId]
      }),
      metadata: () => ({ resourceId, evidenceId })
    });
  }

  markReady(id: string, command: AuthoritativeCommandEnvelope, evidenceId: string) {
    if (!evidenceId) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Enrollment READY transition requires registry evidence"
      );
    }

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "resource-enrollment",
      entityId: id,
      to: "ready",
      command,
      triggeringEvent: "resource-enrollment-ready",
      beforeTransition: (current) => {
        if (!current.resourceId) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Enrollment cannot become READY before authoritative resource registration"
          );
        }
      },
      patch: (current) => ({
        evidenceIds: [...current.evidenceIds, evidenceId]
      }),
      metadata: () => ({ evidenceId })
    });
  }

  fail(
    id: string,
    command: AuthoritativeCommandEnvelope,
    reason: string
  ) {
    if (!reason) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Enrollment failure requires a reason"
      );
    }
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "resource-enrollment",
      entityId: id,
      to: "failed",
      command,
      triggeringEvent: "resource-enrollment-failed",
      patch: () => ({ failureReason: reason }),
      metadata: () => ({ reason })
    });
  }

  cancel(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "resource-enrollment",
      entityId: id,
      to: "cancelled",
      command,
      triggeringEvent: "resource-enrollment-cancelled"
    });
  }

  expire(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "resource-enrollment",
      entityId: id,
      to: "expired",
      command,
      triggeringEvent: "resource-enrollment-expired"
    });
  }

  restart(
    id: string,
    command: AuthoritativeCommandEnvelope,
    challengeToken: string,
    challengeExpiresAt: string,
    restartedAt = new Date().toISOString()
  ) {
    if (Date.parse(challengeExpiresAt) <= Date.parse(restartedAt)) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Restarted enrollment challenge must expire in the future"
      );
    }

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "resource-enrollment",
      entityId: id,
      to: "identify",
      command,
      triggeringEvent: "resource-enrollment-restarted",
      patch: (current) => ({
        challengeHash: hashEnrollmentChallenge(challengeToken),
        challengeIssuedAt: restartedAt,
        challengeExpiresAt,
        challengeConsumedAt: undefined,
        resourceId: undefined,
        evidenceIds: [],
        attempt: current.attempt + 1,
        failureReason: undefined
      }),
      metadata: (current) => ({ attempt: current.attempt + 1 })
    });
  }

  private advance(
    id: string,
    command: AuthoritativeCommandEnvelope,
    to: Extract<ResourceEnrollmentState, "discover" | "profile" | "validate" | "test">,
    event: string,
    evidenceId: string
  ) {
    if (!evidenceId) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Enrollment stage transition requires evidence"
      );
    }

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.enrollments,
      entityType: "resource-enrollment",
      entityId: id,
      to,
      command,
      triggeringEvent: event,
      patch: (current) => ({
        evidenceIds: [...current.evidenceIds, evidenceId]
      }),
      metadata: () => ({ evidenceId })
    });
  }
}
