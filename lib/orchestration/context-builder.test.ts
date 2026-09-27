import { describe, expect, it } from "vitest";
import type { ContextItem } from "@/lib/intelligence/context";
import { OrchestrationContextBuilder } from "@/lib/orchestration/context-builder";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";

const now = new Date("2026-09-27T20:00:00.000Z");

function run(): OrchestrationRun {
  return Object.freeze({
    id: "orchestration:owner-intent:intent-1",
    correlationId: "corr-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging",
    authorityUserId: "user-a",
    initiatingActor: Object.freeze({ type: "user" as const, id: "user-a" }),
    source: Object.freeze({ kind: "owner-intent" as const, ownerIntentId: "intent-1" }),
    state: "context-building",
    attempt: 1,
    version: 2,
    availableAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  });
}

describe("OrchestrationContextBuilder", () => {
  it("builds a hash-bound scoped snapshot and derives the highest included data class", async () => {
    const items: ContextItem[] = [
      {
        id: "owner-input:intent-1",
        kind: "fact",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        source: "owner-intent",
        provenance: "owner-intent:intent-1",
        observedAt: "2026-09-27T19:59:00.000Z",
        freshnessSeconds: 3600,
        sensitivity: "internal",
        content: "Inspect the current repository state."
      },
      {
        id: "customer-signal",
        kind: "signal",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        source: "signal-bus",
        provenance: "signal:customer-1",
        observedAt: "2026-09-27T19:59:30.000Z",
        freshnessSeconds: 3600,
        sensitivity: "customer",
        content: "A customer-scoped signal."
      }
    ];
    const builder = new OrchestrationContextBuilder({
      load: async () => ({
        kind: "ready" as const,
        context: {
          items,
          scope: {
            portfolioId: "portfolio-a",
            companyId: "company-a",
            allowedSensitivity: ["internal", "customer"]
          }
        }
      })
    }, () => now);

    const result = await builder.build(run());
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("expected ready context");
    expect(result.snapshot.dataClass).toBe("customer");
    expect(result.snapshot.assembled.items).toHaveLength(2);
    expect(result.snapshot.contextHash).toHaveLength(64);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
  });

  it("fails closed when a context source attempts to change company scope", async () => {
    const builder = new OrchestrationContextBuilder({
      load: async () => ({
        kind: "ready" as const,
        context: {
          items: [],
          scope: {
            portfolioId: "portfolio-a",
            companyId: "company-b",
            allowedSensitivity: ["internal"]
          }
        }
      })
    }, () => now);

    await expect(builder.build(run())).rejects.toThrow(/outside the orchestration authority/i);
  });

  it("defers when no fresh authorized context survives assembly", async () => {
    const builder = new OrchestrationContextBuilder({
      load: async () => ({
        kind: "ready" as const,
        context: {
          items: [{
            id: "stale",
            kind: "fact" as const,
            portfolioId: "portfolio-a",
            companyId: "company-a",
            source: "test",
            provenance: "test:stale",
            observedAt: "2026-09-20T00:00:00.000Z",
            freshnessSeconds: 60,
            sensitivity: "internal" as const,
            content: "stale"
          }],
          scope: {
            portfolioId: "portfolio-a",
            companyId: "company-a",
            allowedSensitivity: ["internal" as const]
          }
        }
      })
    }, () => now);

    await expect(builder.build(run())).resolves.toMatchObject({
      kind: "unavailable",
      reason: "no-authorized-fresh-context"
    });
  });
});
