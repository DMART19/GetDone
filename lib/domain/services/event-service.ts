import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
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

export interface EventStores {
  events: EntityStore<EventRecord>;
}

export class EventService {
  constructor(private readonly transactions: ControlPlaneTransactionManager<EventStores>) {}

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
