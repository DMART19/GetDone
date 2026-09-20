import { describe, expect, it } from "vitest";
import { dedupeSignals, normalizeEvent, shouldOpenInvestigation } from "@/lib/intelligence/signals";

describe("deterministic signal attention", () => {
  const base = {
    source: "metrics",
    externalId: "evt-1",
    companyId: "company-a",
    type: "error-rate",
    occurredAt: "2026-09-20T16:00:00Z",
    receivedAt: "2026-09-20T16:00:01Z"
  };

  it("escalates critical events without model reasoning", () => {
    expect(normalizeEvent({ ...base, severity: "critical" }).action).toBe("ESCALATE");
  });

  it("deduplicates the same logical signal", () => {
    const signal = normalizeEvent({ ...base, severity: "low" });
    expect(dedupeSignals([signal, signal])).toHaveLength(1);
  });

  it("does not overreact to expected events", () => {
    expect(normalizeEvent({ ...base, expected: true, severity: "high" }).action).toBe("RECORD");
  });

  it("respects freshness and cooldown before opening investigations", () => {
    const signal = normalizeEvent({ ...base, severity: "high" });
    const now = Date.parse("2026-09-20T16:02:00Z");

    expect(shouldOpenInvestigation(signal, {
      now,
      maxAgeMs: 10 * 60_000,
      cooldownMs: 5 * 60_000,
      lastInvestigatedAt: now - 60_000
    })).toBe(false);

    expect(shouldOpenInvestigation(signal, {
      now,
      maxAgeMs: 10 * 60_000,
      cooldownMs: 5 * 60_000,
      lastInvestigatedAt: now - 6 * 60_000
    })).toBe(true);
  });
});
