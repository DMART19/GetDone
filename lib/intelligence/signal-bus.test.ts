import { describe, expect, it } from "vitest";
import {
  SignalBusService,
  parseInboundSignalEvent,
  type NormalizedSignalStore,
  type SignalCursorStore,
  type SignalDedupeStore,
  type SignalScopeResolver
} from "@/lib/intelligence/signal-bus";
import type { NormalizedSignal } from "@/lib/intelligence/signals";

class MemoryDedupe implements SignalDedupeStore {
  readonly keys = new Set<string>();
  async claim(key: string) {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }
}

class MemoryCursors implements SignalCursorStore {
  readonly cursors = new Map<string, { sequence?: number; occurredAt: string }>();
  async get(key: string) {
    return this.cursors.get(key) ?? null;
  }
  async advance(key: string, cursor: { sequence?: number; occurredAt: string }) {
    this.cursors.set(key, cursor);
  }
}

class MemorySignals implements NormalizedSignalStore {
  readonly signals: NormalizedSignal[] = [];
  async append(signal: NormalizedSignal) {
    this.signals.push(signal);
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
  const dedupe = new MemoryDedupe();
  const cursors = new MemoryCursors();
  const signals = new MemorySignals();
  const bus = new SignalBusService({
    scopeResolver: resolver(),
    dedupe,
    cursors,
    signals,
    now: () => new Date("2026-09-20T16:05:00Z"),
    idFactory: () => `signal-${signals.signals.length + 1}`
  });
  return { bus, dedupe, cursors, signals };
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
    const { bus, signals } = createBus();
    await bus.ingest("binding-1", event);
    const retry = await bus.ingest("binding-1", event);
    expect(retry.status).toBe("duplicate");
    expect(signals.signals).toHaveLength(1);
  });

  it("accepts late events without regressing the stream cursor", async () => {
    const { bus, cursors } = createBus();
    await bus.ingest("binding-1", event);

    const late = await bus.ingest("binding-1", {
      ...event,
      eventId: "evt-2",
      sequence: 9,
      occurredAt: "2026-09-20T15:59:00Z"
    });

    expect(late.status).toBe("accepted-out-of-order");
    const [cursor] = [...cursors.cursors.values()];
    expect(cursor.sequence).toBe(10);
    expect(cursor.occurredAt).toBe("2026-09-20T16:00:00Z");
  });

  it("rejects an unknown source binding", async () => {
    const { bus } = createBus();
    await expect(bus.ingest("attacker-binding", event)).rejects.toThrow();
  });
});
