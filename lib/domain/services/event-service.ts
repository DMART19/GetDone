import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { commandFingerprint } from "@/lib/control-plane/command-envelope";
import { createAuditEvent } from "@/lib/domain/audit";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import { claimIdempotency } from "@/lib/domain/idempotency";
import {
  executeTransitionCommand,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";

export type EventState =
  | "recorded"
  | "accepted"
  | "processing"
  | "processed"
  | "ignored"
  | "rejected"
  | "failed";

export interface EventRecord extends StatefulEntity {
  state: EventState;
  eventType: string;
  source: string;
  provenance: string;
  payloadHash: string;
  subjectType?: string;
  subjectId?: string;
  evidenceIds: readonly string[];
  reason?: string;
}

export interface EventStore extends EntityStore<EventRecord> {
  create(record: EventRecord): Promise<void>;
}

export interface EventStores {
  events: EventStore;
}

export interface RecordEventInput {
  id: string;
  eventType: string;
  source: string;
  provenance: string;
  payloadHash: string;
  subjectType?: string;
  subjectId?: string;
  evidenceIds?: readonly string[];
  recordedAt?: string;
}

export class EventService {
  constructor(private readonly transactions: ControlPlaneTransactionManager<EventStores>) {}

  async record(input: RecordEventInput, command: AuthoritativeCommandEnvelope) {
    if (!input.id || !input.eventType || !input.source || !input.provenance || !input.payloadHash) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Authoritative events require identity, type, source, provenance, and payload hash"
      );
    }

    const fingerprint = commandFingerprint(command);
    const recordedAt = input.recordedAt ?? new Date().toISOString();

    return this.transactions.run(async (transaction) => {
      const claim = await claimIdempotency<EventRecord>(
        transaction.idempotency,
        command.idempotencyKey,
        fingerprint,
        new Date(recordedAt)
      );

      if (claim.state === "COMPLETED" && claim.record.result) {
        return claim.record.result;
      }
      if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
        throw new ControlPlaneError(
          "CONFLICT",
          "The authoritative event command is already in progress or previously failed",
          { correlationId: command.correlationId }
        );
      }

      const record: EventRecord = Object.freeze({
        id: input.id,
        portfolioId: command.scope.portfolioId,
        companyId: command.scope.companyId,
        state: "recorded",
        eventType: input.eventType,
        source: input.source,
        provenance: input.provenance,
        payloadHash: input.payloadHash,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        evidenceIds: Object.freeze([...(input.evidenceIds ?? [])]),
        version: 1,
        updatedAt: recordedAt
      });

      await transaction.stores.events.create(record);
      await transaction.audit.append(createAuditEvent({
        correlationId: command.correlationId,
        eventType: "event.recorded",
        actor: command.actor,
        scope: {
          userId: command.scope.userId,
          portfolioId: command.scope.portfolioId,
          companyId: command.scope.companyId,
          resourceId: command.scope.resourceId
        },
        environment: command.environment,
        entityType: "event",
        entityId: record.id,
        newState: "recorded",
        provenance: command.provenance,
        metadata: {
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          source: record.source,
          eventType: record.eventType,
          payloadHash: record.payloadHash
        }
      }));

      await transaction.idempotency.complete(
        command.idempotencyKey,
        fingerprint,
        record,
        recordedAt
      );

      return record;
    });
  }

  accept(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.events,
      entityType: "event",
      entityId: id,
      to: "accepted",
      command,
      triggeringEvent: "event-accepted"
    });
  }

  beginProcessing(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.events,
      entityType: "event",
      entityId: id,
      to: "processing",
      command,
      triggeringEvent: "event-processing-started"
    });
  }

  markProcessed(id: string, command: AuthoritativeCommandEnvelope, evidenceIds: readonly string[]) {
    if (evidenceIds.length === 0) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Processed events require evidence");
    }
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.events,
      entityType: "event",
      entityId: id,
      to: "processed",
      command,
      triggeringEvent: "event-processed",
      patch: () => ({ evidenceIds: [...evidenceIds] }),
      metadata: () => ({ evidenceCount: evidenceIds.length })
    });
  }

  ignore(id: string, command: AuthoritativeCommandEnvelope, reason: string) {
    if (!reason) throw new ControlPlaneError("VALIDATION_FAILED", "Ignored events require a reason");
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.events,
      entityType: "event",
      entityId: id,
      to: "ignored",
      command,
      triggeringEvent: "event-ignored",
      patch: () => ({ reason }),
      metadata: () => ({ reason })
    });
  }

  reject(id: string, command: AuthoritativeCommandEnvelope, reason: string) {
    if (!reason) throw new ControlPlaneError("VALIDATION_FAILED", "Rejected events require a reason");
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.events,
      entityType: "event",
      entityId: id,
      to: "rejected",
      command,
      triggeringEvent: "event-rejected",
      patch: () => ({ reason }),
      metadata: () => ({ reason })
    });
  }

  fail(id: string, command: AuthoritativeCommandEnvelope, reason: string) {
    if (!reason) throw new ControlPlaneError("VALIDATION_FAILED", "Failed events require a reason");
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.events,
      entityType: "event",
      entityId: id,
      to: "failed",
      command,
      triggeringEvent: "event-failed",
      patch: () => ({ reason }),
      metadata: () => ({ reason })
    });
  }
}
