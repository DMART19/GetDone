import { describe, expect, it } from "vitest";
import { summarizeBusinessCapabilities } from "./capability-summary";
import type { BusinessContext, BusinessRecord, BusinessSection } from "./contracts";

function context(overrides: Partial<Record<BusinessSection, BusinessRecord[]>> = {}): BusinessContext {
  const sections = Object.fromEntries(
    (["objectives", "integrations", "signals", "decisions", "jobs", "outcomes"] as BusinessSection[])
      .map(section => [section, { records: overrides[section] ?? [], note: section === "signals" ? "Signal feed unavailable." : undefined }])
  ) as BusinessContext["sections"];
  return { business: { id: "company", portfolioId: "portfolio", name: "Example" }, sections };
}
const record = (status: string): BusinessRecord => ({ id: status, title: status, status, updatedAt: "2026-01-01T00:00:00Z" });

describe("scoped business capability presentation", () => {
  it("does not imply healthy or connected state for empty or completed records", () => {
    const capabilities = summarizeBusinessCapabilities(context({ jobs: [record("completed")], integrations: [record("active")] }));
    expect(capabilities.find(item => item.section === "jobs")?.state).toBe("unknown");
    expect(capabilities.find(item => item.section === "integrations")?.state).toBe("unknown");
    expect(capabilities.find(item => item.section === "signals")?.reason).toBe("Signal feed unavailable.");
  });
  it("surfaces explicit blocked and degraded records without inventing verification", () => {
    const capabilities = summarizeBusinessCapabilities(context({
      jobs: [record("failed"), record("pending")],
      decisions: [record("pending")]
    }));
    expect(capabilities.find(item => item.section === "jobs")?.state).toBe("blocked");
    expect(capabilities.find(item => item.section === "decisions")?.state).toBe("degraded");
    expect(capabilities.find(item => item.section === "objectives")?.state).toBe("unknown");
  });
});
