import { describe, expect, it } from "vitest";
import {
  SignalBusService,
  parseInboundSignalEvent,
  type NormalizedSignalStore,
  type SignalBusPersistence,
  type SignalBusTransaction,
  type SignalCursorStore,
  type SignalDedupeStore,
  type SignalScopeResolver
} from "@/lib/intelligence/signal-bus";
import type { NormalizedSignal } from "@/lib/intelligence/signals";

class MemorySignalPersistence implements SignalBusPersistence {
  keys = new Set<string>();
  cursors = new Map<string, { sequence?: number; occurredAt: string }>();
  signals: NormalizedSignal[] = [];
  failAppend = false;

  async run<T>(operation: (transaction: SignalBusTransaction) => Promise<T>) {
    const stagedKeys = new Set(this.keys);
    const stagedCursors = new Map(this.cursors);
    const stagedSignals = [...this.signals];

    const dedupe: SignalDedupeStore = {
      claim: async (key) => {
        if (stagedKeys.has(key)) return false;
        stagedKeys.add(key);
        return true;
      }
    };

    const cursors: SignalCursorStore = {
      get: async (key) => stagedCursors.get(key) ?? null,
      advance: async (key, cursor) => {
        stagedCursors.set(key, cursor);
      }
    };

    const signals: NormalizedSignalStore = {
      append: async (signal) => {
        if (this.failAppend) throw new Error("simulated signal persistence failure");
        stagedSignals.push(signal);
      }
    };

    const result = await operation({ dedupe, cursors, signals });
    this.keys = stagedKeys;
    this.cursors = stagedCursors;
    this.signals = stagedSignals;
    return result;
  }
}

function resolver(): SignalScopeResolver {
  return {
    async resolve({ sourceBindingId, externalResourceRef }) {
      if (sourceBindingId !== "binding-1") return null;
      return {
        binding: {
          id: "binding-1",
          sourceName: "metrics-provider",
          portfolioId: "portfolio-a",
          companyId: "company-a",
          enabled: true
        },
        scope: {
          portfolioId: "portfolio-a",
          companyId: "company-a",
          resourceId: externalResourceRef === "node-42" ? "resource-a" : undefined
        }
      };
    }
  };
}

function createBus() {
  const persistence = new MemorySignalPersistence();
  const bus = new SignalBusService({
    scopeResolver: resolver(),
    persistence,
    now: () => new Date("2026-09-20T16:05:00Z"),
    idFactory: () => `signal-${persistence.signals.length + 1}`
  });
  return { bus, persistence };
}

const event = {
  eventId: "evt-1",
  streamKey: "resource-health",
  type: "resource.degraded",
  occurredAt: "2026-09-20T16:00:00Z",
  sequence: 10,
  externalResourceRef: "node-42",
  severity: "high" as const
};

describe("signal bus", () => {
  it("validates ingress and refuses caller-supplied company authority", () => {
    expect(parseInboundSignalEvent(event).eventId).toBe("evt-1");
    expect(() => parseInboundSignalEvent({ ...event, companyId: "company-b" })).toThrow();
  });

  it("resolves company/resource scope from the trusted source binding", async () => {
    const { bus } = createBus();
    const result = await bus.ingest("binding-1", event);
    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(result.signal.scope).toEqual({
        portfolioId: "portfolio-a",
        companyId: "company-a",
        resourceId: "resource-a"
      });
      expect(result.signal.provenance).toBe("metrics-provider:binding-1:evt-1");
    }
  });

  it("deduplicates a repeated logical provider event", async () => {
    const { bus, persistence } = createBus();
    await bus.ingest("binding-1", event);
    const retry = await bus.ingest("binding-1", event);
    expect(retry.status).toBe("duplicate");
    expect(persistence.signals).toHaveLength(1);
  });

  it("accepts late events without regressing the stream cursor", async () => {
    const { bus, persistence } = createBus();
    await bus.ingest("binding-1", event);

    const late = await bus.ingest("binding-1", {
      ...event,
      eventId: "evt-2",
      sequence: 9,
      occurredAt: "2026-09-20T15:59:00Z"
    });

    expect(late.status).toBe("accepted-out-of-order");
    const [cursor] = [...persistence.cursors.values()];
    expect(cursor.sequence).toBe(10);
    expect(cursor.occurredAt).toBe("2026-09-20T16:00:00Z");
  });

  it("rolls back a dedupe claim if normalized-signal persistence fails", async () => {
    const { bus, persistence } = createBus();
    persistence.failAppend = true;

    await expect(bus.ingest("binding-1", event)).rejects.toThrow("simulated signal persistence failure");
    expect(persistence.keys.size).toBe(0);
    expect(persistence.signals).toHaveLength(0);

    persistence.failAppend = false;
    expect((await bus.ingest("binding-1", event)).status).toBe("accepted");
  });

  it("rejects an unknown source binding", async () => {
    const { bus } = createBus();
    await expect(bus.ingest("attacker-binding", event)).rejects.toThrow();
  });
});
