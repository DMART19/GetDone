import { describe, expect, it } from "vitest";
import { portfolioAttentionOverview } from "./portfolio-attention";
import type { BusinessContext, BusinessSection, BusinessRecord } from "./contracts";

const sections: readonly BusinessSection[] = ["objectives", "integrations", "signals", "decisions", "jobs", "outcomes"];
function context(company: string, portfolioId: string, overrides: Partial<Record<BusinessSection, BusinessRecord[]>>): BusinessContext {
  return {
    business: { id: company, portfolioId, name: company },
    sections: Object.fromEntries(sections.map(section => [section, {
      records: overrides[section] ?? [], note: section === "signals" ? "Feed unavailable" : undefined
    }])) as BusinessContext["sections"]
  };
}
const record = (id: string, status: string): BusinessRecord => ({
  id, title: id, status, updatedAt: "2026-10-22T12:00:00Z"
});

describe("multi-business owner attention overview", () => {
  it("sorts approvals before input and failures across businesses", () => {
    const first = context("OpsManagerPro", "p-ops", {jobs:[record("failure","failed")]});
    const second = context("StatusWatchPro", "p-status", {
      decisions:[record("release","pending")], objectives:[record("clarify","needs_owner_input")]
    });
    const view = portfolioAttentionOverview([first,second],{totalBusinesses:2});
    expect(view.items.map(item=>item.kind)).toEqual(["approval","owner_input","blocked"]);
    expect(view.items.map(item=>item.businessName)).toEqual(["StatusWatchPro","StatusWatchPro","OpsManagerPro"]);
    expect(view.items[0]).toMatchObject({portfolioId:"p-status",businessId:"StatusWatchPro",recordId:"release",section:"decisions"});
    expect(view.incomplete).toBe(false);
  });
  it("does not collapse same record identifiers across company scopes", () => {
    const a = context("A","a",{jobs:[record("job-1","failed")]});
    const b = context("B","b",{jobs:[record("job-1","failed")]});
    const view=portfolioAttentionOverview([a,b],{totalBusinesses:2});
    expect(view.items).toHaveLength(2);
    expect(new Set(view.items.map(x=>x.id)).size).toBe(2);
  });
  it("reports truncation and never asserts verified live capability", () => {
    const view=portfolioAttentionOverview([context("A","p",{decisions:[record("approval","pending")]})],
      {totalBusinesses:3,maxItems:0});
    expect(view.items).toHaveLength(0);
    expect(view.incomplete).toBe(true);
    expect(view.note).toContain("not proof of live connector health");
  });
  it("ignores completed records without inventing issues", () => {
    const view=portfolioAttentionOverview([context("A","p",{jobs:[record("done","completed")]})],{totalBusinesses:1});
    expect(view.items).toEqual([]);
  });
});
