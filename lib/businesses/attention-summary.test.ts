import { describe, expect, it } from "vitest";
import { businessAttention } from "./attention-summary";
import type { BusinessContext, BusinessRecord, BusinessSection } from "./contracts";

const rec = (id: string, status: string): BusinessRecord => ({ id, title: id, status, updatedAt: "2026-01-01T00:00:00Z" });
function fixture(overrides: Partial<Record<BusinessSection, BusinessRecord[]>>): BusinessContext {
  return {
    business: { id: "c1", portfolioId: "p1", name: "Test" },
    sections: Object.fromEntries((["objectives", "integrations", "signals", "decisions", "jobs", "outcomes"] as BusinessSection[]).map(
      section => [section, { records: overrides[section] ?? [] }]
    )) as BusinessContext["sections"]
  };
}

describe("planet-scoped owner attention", () => {
  it("only includes actionable known statuses and correctly prioritizes owner approval", () => {
    const items = businessAttention(fixture({
      decisions: [rec("approval", "pending"), rec("resolved", "approved")],
      objectives: [rec("missing-input", "needs_owner_input"), rec("finished", "completed")],
      jobs: [rec("error", "failed"), rec("queued", "queued")],
      integrations: [rec("degraded-connector", "degraded")]
    }));
    expect(items.map(item => item.kind)).toEqual(["approval", "owner_input", "blocked", "review"]);
    expect(items.map(item => item.title)).toEqual(["approval", "missing-input", "error", "degraded-connector"]);
  });
  it("does not invent attention items when there are no actionable records", () => {
    expect(businessAttention(fixture({ decisions: [rec("done", "approved")] }))).toEqual([]);
  });
});
