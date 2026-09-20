import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditLedger } from "@/lib/domain/audit";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import type { IdempotencyClaim, IdempotencyRecord, IdempotencyStore } from "@/lib/domain/idempotency";
import {
  EventService,
  type EventRecord,
  type EventStores
} from "@/lib/domain/services/event-service";

class EventTransactionManager implements ControlPlaneTransactionManager<EventStores> {
  private value: EventRecord;
  private events: AuditEvent[] = [];
  private idempotency = new Map<string, IdempotencyRecord>();

  constructor(initial: EventRecord) {
    this.value = { ...initial };
  }

  event() { return { ...this.value }; }
  audit() { return [...this.events]; }

  async run<T>(operation: Parameters<ControlPlaneTransactionManager<EventStores>["run"]>[0]) {
    let staged = { ...this.value };
    const stagedEvents = [...this.events];
    const stagedIdempotency = new Map(this.idempotency);

    const store = {
      get: async (id: string) => id === staged.id ? { ...staged } : null,
      save: async (next: EventRecord, expectedVersion: number) => {
        if (staged.version !== expectedVersion) throw new Error("optimistic concurrency conflict");
        staged = { ...next };
      },
      create: async (record: EventRecord) => {
        if (staged.id === record.id) throw new Error("event already exists");
        staged = { ...record };
      }
    };

    const audit: AuditLedger = {
      append: async (event) => { stagedEvents.push(event); },
      listByCorrelationId: async (correlationId) => stagedEvents.filter((event) => event.correlationId === correlationId)
    };

    const idempotency: IdempotencyStore = {
      async claim<R = unknown>(key: string, fingerprint: string, createdAt: string): Promise<IdempotencyClaim<R>> {
        const existing = stagedIdempotency.get(key) as IdempotencyRecord<R> | undefined;
        if (existing) {
          if (existing.fingerprint !== fingerprint) return { state: "CONFLICT", record: existing };
          return { state: existing.status, record: existing };
        }
        const record: IdempotencyRecord<R> = { key, fingerprint, status: "IN_PROGRESS", createdAt };
        stagedIdempotency.set(key, record as IdempotencyRecord);
        return { state: "CREATED", record };
      },
      async complete<R = unknown>(key: string, fingerprint: string, result: R, completedAt: string) {
        const existing = stagedIdempotency.get(key);
        if (!existing || existing.fingerprint !== fingerprint) throw new Error("idempotency conflict");
        const record: IdempotencyRecord<R> = { ...existing, status: "COMPLETED", completedAt, result };
        stagedIdempotency.set(key, record as IdempotencyRecord);
        return record;
      },
      async fail(key: string, fingerprint: string, errorCode: string, failedAt: string) {
        const existing = stagedIdempotency.get(key);
        if (!existing || existing.fingerprint !== fingerprint) throw new Error("idempotency conflict");
        const record: IdempotencyRecord = { ...existing, status: "FAILED", failedAt, errorCode };
        stagedIdempotency.set(key, record);
        return record;
      },
      async get<R = unknown>(key: string) {
        return (stagedIdempotency.get(key) as IdempotencyRecord<R> | undefined) ?? null;
      }
    };

    const result = await operation({ stores: { events: store }, audit, idempotency });
    this.value = staged;
    this.events = stagedEvents;
    this.idempotency = stagedIdempotency;
    return result as T;
  }
}

function command(type: string) {
  return createCommandEnvelope({
    commandId: `event-command-${type}`,
    actor: { type: "system", id: "getdone-control-plane" },
    scope: {
      userId: "user-a",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "development"
    },
    correlationId: `event-correlation-${type}`,
    environment: "development",
    idempotencyKey: `event-idempotency-${type}`,
    provenance: "control-plane",
    requestedMutation: { type }
  });
}

const initial: EventRecord = {
  id: "event-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  state: "recorded",
  eventType: "plan.validation.requested",
  source: "control-plane",
  provenance: "plan:plan-1",
  payloadHash: "abc123",
  evidenceIds: [],
  version: 1,
  updatedAt: "2026-09-20T18:00:00Z"
};

describe("authoritative event service", () => {
  it("records first-class authoritative events transactionally", async () => {
    const manager = new EventTransactionManager(initial);
    const service = new EventService(manager);
    const recorded = await service.record({
      id: "event-2",
      eventType: "task.authorization.consumed",
      source: "control-plane",
      provenance: "task:task-1",
      payloadHash: "payload-sha256",
      recordedAt: "2026-09-20T18:01:00Z"
    }, command("record"));

    expect(recorded.state).toBe("recorded");
    expect(recorded.companyId).toBe("company-a");
    expect(manager.audit()[0].eventType).toBe("event.recorded");
  });

  it("treats control-plane events as first-class stateful entities", async () => {
    const manager = new EventTransactionManager(initial);
    const service = new EventService(manager);

    expect((await service.accept("event-1", command("accept"))).state).toBe("accepted");
    expect((await service.beginProcessing("event-1", command("process"))).state).toBe("processing");
    expect((await service.markProcessed("event-1", command("done"), ["evidence-1"])).state).toBe("processed");
    expect(manager.audit().map((event) => event.eventType)).toEqual([
      "event.accepted",
      "event.processing",
      "event.processed"
    ]);
  });

  it("rejects cross-company event transitions", async () => {
    const manager = new EventTransactionManager(initial);
    const service = new EventService(manager);
    const wrong = createCommandEnvelope({
      ...command("wrong-company"),
      scope: {
        userId: "user-a",
        portfolioId: "portfolio-a",
        companyId: "company-b",
        environment: "development"
      }
    });
    await expect(service.accept("event-1", wrong)).rejects.toThrow();
  });

  it("requires evidence before an event can be marked processed", async () => {
    const manager = new EventTransactionManager({ ...initial, state: "processing" });
    const service = new EventService(manager);
    expect(() => service.markProcessed("event-1", command("no-evidence"), [])).toThrow();
  });
});
