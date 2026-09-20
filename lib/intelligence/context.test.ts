import { describe, expect, it } from "vitest";
import { assembleContext, type ContextItem } from "@/lib/intelligence/context";

const items: ContextItem[] = [
  { id: "a", kind: "fact", portfolioId: "p1", companyId: "c1", source: "db", observedAt: "2026-09-20T10:00:00Z", freshnessSeconds: 60, sensitivity: "internal", content: "Company one" },
  { id: "b", kind: "fact", portfolioId: "p1", companyId: "c2", source: "db", observedAt: "2026-09-20T11:00:00Z", freshnessSeconds: 60, sensitivity: "internal", content: "Company two" },
  { id: "c", kind: "fact", portfolioId: "p2", companyId: "c3", source: "db", observedAt: "2026-09-20T12:00:00Z", freshnessSeconds: 60, sensitivity: "public", content: "Other portfolio" }
];

describe("context scope", () => {
  it("does not leak another company into company context", () => {
    const result = assembleContext(items, { portfolioId: "p1", companyId: "c1", allowedSensitivity: ["internal"] });
    expect(result.items.map((item) => item.id)).toEqual(["a"]);
  });

  it("bounds the context item count", () => {
    const result = assembleContext(items, { portfolioId: "p1", allowedSensitivity: ["internal"] }, 1);
    expect(result.items).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("bounds total content size", () => {
    const result = assembleContext(items, { portfolioId: "p1", allowedSensitivity: ["internal"] }, 30, 10);
    expect(result.characterCount).toBeLessThanOrEqual(10);
    expect(result.truncated).toBe(true);
  });
});
