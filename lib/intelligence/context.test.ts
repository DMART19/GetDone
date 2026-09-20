import { describe, expect, it } from "vitest";
import {
  assembleContext,
  isContextItemFresh,
  type ContextItem
} from "@/lib/intelligence/context";

const now = Date.parse("2026-09-20T16:00:00Z");

const items: ContextItem[] = [
  {
    id: "fact-c1",
    kind: "fact",
    portfolioId: "p1",
    companyId: "c1",
    source: "db",
    provenance: "db:fact-c1",
    observedAt: "2026-09-20T15:59:00Z",
    freshnessSeconds: 600,
    sensitivity: "internal",
    content: "Company one fact"
  },
  {
    id: "signal-c1",
    kind: "signal",
    portfolioId: "p1",
    companyId: "c1",
    source: "signal-bus",
    provenance: "signal:1",
    observedAt: "2026-09-20T15:58:00Z",
    freshnessSeconds: 600,
    sensitivity: "internal",
    content: "Company one signal"
  },
  {
    id: "decision-c1",
    kind: "decision",
    portfolioId: "p1",
    companyId: "c1",
    source: "control-plane",
    provenance: "decision:1",
    observedAt: "2026-09-20T15:57:00Z",
    freshnessSeconds: 3600,
    sensitivity: "internal",
    content: "Company one decision"
  },
  {
    id: "resource-r1",
    kind: "resource-summary",
    portfolioId: "p1",
    companyId: "c1",
    resourceId: "r1",
    source: "resource-registry",
    provenance: "resource:r1",
    observedAt: "2026-09-20T15:59:30Z",
    freshnessSeconds: 300,
    sensitivity: "internal",
    content: "Resource one healthy"
  },
  {
    id: "resource-r2",
    kind: "resource-summary",
    portfolioId: "p1",
    companyId: "c1",
    resourceId: "r2",
    source: "resource-registry",
    provenance: "resource:r2",
    observedAt: "2026-09-20T15:59:30Z",
    freshnessSeconds: 300,
    sensitivity: "sensitive",
    content: "Resource two secret detail"
  },
  {
    id: "other-company",
    kind: "fact",
    portfolioId: "p1",
    companyId: "c2",
    source: "db",
    provenance: "db:other-company",
    observedAt: "2026-09-20T15:59:00Z",
    freshnessSeconds: 600,
    sensitivity: "internal",
    content: "Company two private fact"
  },
  {
    id: "stale",
    kind: "outcome",
    portfolioId: "p1",
    companyId: "c1",
    source: "outcomes",
    provenance: "outcome:old",
    observedAt: "2026-09-20T14:00:00Z",
    freshnessSeconds: 60,
    sensitivity: "internal",
    content: "Old outcome"
  },
  {
    id: "portfolio-policy",
    kind: "policy",
    portfolioId: "p1",
    source: "policy",
    provenance: "policy:portfolio",
    observedAt: "2026-09-20T15:55:00Z",
    freshnessSeconds: 3600,
    sensitivity: "internal",
    content: "Portfolio policy"
  }
];

describe("context assembler", () => {
  it("filters stale context rather than merely labeling it", () => {
    expect(isContextItemFresh(items.find((item) => item.id === "stale")!, now)).toBe(false);

    const result = assembleContext(items, {
      portfolioId: "p1",
      companyId: "c1",
      allowedResourceIds: ["r1"],
      allowedSensitivity: ["internal"]
    }, { now });

    expect(result.items.some((item) => item.id === "stale")).toBe(false);
    expect(result.excluded.stale).toBe(1);
  });

  it("does not leak another company's private context", () => {
    const result = assembleContext(items, {
      portfolioId: "p1",
      companyId: "c1",
      allowedResourceIds: ["r1"],
      allowedSensitivity: ["internal"]
    }, { now });

    expect(result.items.some((item) => item.companyId === "c2")).toBe(false);
    expect(result.excluded.unauthorizedScope).toBeGreaterThan(0);
  });

  it("requires explicit resource authorization for resource summaries", () => {
    const result = assembleContext(items, {
      portfolioId: "p1",
      companyId: "c1",
      allowedResourceIds: ["r1"],
      allowedSensitivity: ["internal", "sensitive"]
    }, { now });

    expect(result.sections.resourceSummaries.items.map((item) => item.resourceId)).toEqual(["r1"]);
    expect(result.excluded.resourceScope).toBe(1);
  });

  it("creates bounded typed sections and preserves provenance/company attribution", () => {
    const result = assembleContext(items, {
      portfolioId: "p1",
      allowedResourceIds: ["r1"],
      allowedSensitivity: ["internal"]
    }, {
      now,
      maxItems: 5,
      maxCharacters: 1000,
      maxItemsPerSection: { fact: 1 }
    });

    expect(result.sections.facts.items).toHaveLength(1);
    expect(result.sections.signals.kind).toBe("signal");
    expect(result.items.every((item) => item.provenance.length > 0)).toBe(true);
    expect(result.items.filter((item) => item.companyId).every((item) => ["c1", "c2"].includes(item.companyId!))).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("enforces a global character budget", () => {
    const result = assembleContext(items, {
      portfolioId: "p1",
      companyId: "c1",
      allowedResourceIds: ["r1"],
      allowedSensitivity: ["internal"]
    }, {
      now,
      maxItems: 30,
      maxCharacters: 20
    });

    expect(result.characterCount).toBeLessThanOrEqual(20);
    expect(result.excluded.size).toBeGreaterThan(0);
  });
});
