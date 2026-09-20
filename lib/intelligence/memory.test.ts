import { describe, expect, it } from "vitest";
import {
  createOperationalMemory,
  operationalMemoryToContextItems,
  selectOperationalMemory,
  type OperationalMemoryRecord
} from "@/lib/intelligence/memory";
import { assembleContext } from "@/lib/intelligence/context";

const now = Date.parse("2026-09-20T20:00:00Z");

function fact(
  id: string,
  companyId: string,
  overrides: Partial<Parameters<typeof createOperationalMemory>[0]> = {}
) {
  return createOperationalMemory({
    id,
    kind: "fact",
    portfolioId: "portfolio-a",
    companyId,
    statement: "Checkout latency improved after cache warmup",
    confidence: 0.9,
    sampleSize: 40,
    confounders: [],
    evidenceIds: ["evidence-1"],
    relevanceTags: ["latency", "checkout"],
    observedAt: "2026-09-20T19:50:00Z",
    expiresAt: "2026-09-21T19:50:00Z",
    sensitivity: "internal",
    ...overrides
  } as Parameters<typeof createOperationalMemory>[0]);
}

describe("operational memory", () => {
  it("strictly isolates company memory", () => {
    const selected = selectOperationalMemory(
      [fact("a", "company-a"), fact("b", "company-b")],
      { portfolioId: "portfolio-a", companyId: "company-a" },
      { now }
    );

    expect(selected.map((item) => item.id)).toEqual(["a"]);
  });

  it("drops expired and superseded records", () => {
    const old = fact("old", "company-a");
    const replacement = fact("new", "company-a", { supersedesId: "old" });
    const expired = fact("expired", "company-a", {
      observedAt: "2026-09-19T18:00:00Z",
      expiresAt: "2026-09-19T19:00:00Z"
    });

    const selected = selectOperationalMemory(
      [old, replacement, expired],
      { portfolioId: "portfolio-a", companyId: "company-a" },
      { now }
    );

    expect(selected.map((item) => item.id)).toEqual(["new"]);
  });

  it("selects relevant memory deterministically", () => {
    const latency = fact("latency", "company-a");
    const revenue = createOperationalMemory({
      id: "revenue",
      kind: "observation",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      observation: "Revenue rose after annual pricing launch",
      confidence: 0.95,
      sampleSize: 100,
      confounders: ["seasonality"],
      evidenceIds: ["evidence-2"],
      relevanceTags: ["revenue", "pricing"],
      observedAt: "2026-09-20T19:55:00Z",
      sensitivity: "internal"
    });

    const selected = selectOperationalMemory(
      [latency, revenue],
      { portfolioId: "portfolio-a", companyId: "company-a" },
      { now, tags: ["latency"], textTerms: ["checkout"] }
    );

    expect(selected[0].id).toBe("latency");
  });

  it("feeds advisory memory into the bounded context assembler", () => {
    const records: OperationalMemoryRecord[] = [fact("context", "company-a")];
    const items = operationalMemoryToContextItems(records);
    const context = assembleContext(items, {
      portfolioId: "portfolio-a",
      companyId: "company-a",
      allowedSensitivity: ["internal"]
    }, { now });

    expect(context.sections.memory.items).toHaveLength(1);
    expect(context.sections.memory.items[0].source).toBe("operational-memory");
  });

  it("detects memory mutation", () => {
    const original = fact("tamper", "company-a");
    expect(() => selectOperationalMemory(
      [{ ...original, confidence: 0.1 } as OperationalMemoryRecord],
      { portfolioId: "portfolio-a", companyId: "company-a" },
      { now }
    )).toThrow();
  });
});
