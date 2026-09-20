import { describe, expect, it } from "vitest";
import { assembleContext } from "@/lib/intelligence/context";
import {
  operationalMemoryToContextItem,
  selectOperationalMemory,
  type Fact,
  type Lesson
} from "@/lib/intelligence/memory";

const now = Date.parse("2026-09-20T20:00:00Z");

const base = {
  portfolioId: "portfolio-a",
  companyId: "company-a",
  authority: "advisory" as const,
  sensitivity: "internal" as const,
  source: "outcome-analysis",
  provenance: "outcome:1",
  observedAt: "2026-09-20T19:00:00Z",
  evidenceIds: ["evidence-1"],
  confidence: 0.9,
  sampleSize: 20,
  confounders: [] as string[],
  tags: ["email", "conversion"] as string[]
};

describe("operational memory", () => {
  it("strictly isolates company memory", () => {
    const companyA: Fact = { ...base, id: "fact-a", kind: "fact", statement: "A fact" };
    const companyB: Fact = {
      ...base,
      id: "fact-b",
      companyId: "company-b",
      kind: "fact",
      statement: "B private fact"
    };

    const selected = selectOperationalMemory([companyA, companyB], {
      portfolioId: "portfolio-a",
      companyId: "company-a"
    }, { now });

    expect(selected.map((item) => item.id)).toEqual(["fact-a"]);
  });

  it("excludes expired and superseded memory", () => {
    const expired: Fact = {
      ...base,
      id: "expired",
      kind: "fact",
      statement: "Old fact",
      expiresAt: "2026-09-20T19:30:00Z"
    };
    const superseded: Fact = {
      ...base,
      id: "old",
      kind: "fact",
      statement: "Old version",
      supersededById: "new"
    };
    const current: Fact = { ...base, id: "new", kind: "fact", statement: "Current version" };

    expect(selectOperationalMemory(
      [expired, superseded, current],
      { portfolioId: "portfolio-a", companyId: "company-a" },
      { now }
    ).map((item) => item.id)).toEqual(["new"]);
  });

  it("ranks relevant lessons without granting them policy authority", () => {
    const relevant: Lesson = {
      ...base,
      id: "lesson-email",
      kind: "lesson",
      lesson: "Shorter outreach performed better in this sample",
      recommendedAction: "Test the shorter variant again",
      tags: ["email", "conversion"]
    };
    const other: Lesson = {
      ...base,
      id: "lesson-cost",
      kind: "lesson",
      lesson: "Compute cost changed",
      tags: ["compute"]
    };

    const selected = selectOperationalMemory(
      [other, relevant],
      { portfolioId: "portfolio-a", companyId: "company-a" },
      { now, queryTags: ["email"] }
    );

    expect(selected[0].id).toBe("lesson-email");
    expect(selected[0].authority).toBe("advisory");
  });

  it("integrates selected memory into the bounded context assembler", () => {
    const fact: Fact = { ...base, id: "fact-a", kind: "fact", statement: "Verified operational fact" };
    const item = operationalMemoryToContextItem(fact, now);
    const assembled = assembleContext([item], {
      portfolioId: "portfolio-a",
      companyId: "company-a",
      allowedSensitivity: ["internal"]
    }, { now });

    expect(assembled.sections.memories.items).toHaveLength(1);
    expect(assembled.sections.memories.items[0].content).toContain("Verified operational fact");
  });
});
