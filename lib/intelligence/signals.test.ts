import { describe, expect, it } from "vitest";
import type { Investigation, InvestigationStore } from "@/lib/intelligence/investigations";
import { InvestigationCoordinator } from "@/lib/intelligence/investigations";
import {
  evaluateSignal,
  ScopedSensingProfileResolver,
  SensingEngine,
  validateSensingProfile,
  type RecentSignalReader,
  type SensingProfile,
  type SensingProfileResolver
} from "@/lib/intelligence/sensing";
import type { NormalizedSignal } from "@/lib/intelligence/signals";

function signal(overrides: Partial<NormalizedSignal> = {}): NormalizedSignal {
  return {
    id: "signal-1",
    dedupeKey: "dedupe-1",
    sourceBindingId: "binding-1",
    eventId: "evt-1",
    streamKey: "business-metrics",
    type: "business.error-rate",
    occurredAt: "2026-09-20T16:00:00Z",
    receivedAt: "2026-09-20T16:00:01Z",
    scope: { portfolioId: "p1", companyId: "c1" },
    metric: "error-rate",
    value: 0.02,
    severity: "info",
    attributes: {},
    provenance: "metrics:binding-1:evt-1",
    outOfOrder: false,
    ...overrides
  };
}

const profile: SensingProfile = {
  id: "profile-1",
  portfolioId: "p1",
  companyId: "c1",
  signalType: "business.error-rate",
  metric: "error-rate",
  baselineValue: 0.01,
  direction: "increase-is-bad",
  monitorDeviationRatio: 0.2,
  investigateDeviationRatio: 0.5,
  escalateDeviationRatio: 1.5,
  windowSeconds: 600,
  minimumSamples: 2,
  sustainedSeconds: 300,
  maxAgeSeconds: 900,
  cooldownSeconds: 600
};

class MemoryInvestigations implements InvestigationStore {
  latest: Investigation | null = null;

  async findLatestByKey() {
    return this.latest;
  }

  async create(investigation: Investigation) {
    this.latest = investigation;
  }

  async appendSignal(input: {
    investigationId: string;
    signalId: string;
    lastSignalAt: string;
    severity: Investigation["severity"];
    action: Investigation["action"];
    expectedVersion: number;
  }) {
    if (!this.latest || this.latest.id !== input.investigationId || this.latest.version !== input.expectedVersion) {
      throw new Error("investigation concurrency conflict");
    }
    this.latest = {
      ...this.latest,
      signalIds: [...this.latest.signalIds, input.signalId],
      lastSignalAt: input.lastSignalAt,
      severity: input.severity,
      action: input.action,
      version: this.latest.version + 1
    };
    return this.latest;
  }
}

describe("deterministic sensing", () => {
  it("ignores normal numeric fluctuation below the monitoring threshold", () => {
    const result = evaluateSignal(signal({ value: 0.0105, sustainedForSeconds: 300 }), profile, [signal({ id: "prior", value: 0.0104 })], Date.parse("2026-09-20T16:01:00Z"));
    expect(result.action).toBe("IGNORE");
  });

  it("creates investigation-worthy attention only after sustained threshold evidence", () => {
    const result = evaluateSignal(
      signal({ value: 0.018, sustainedForSeconds: 300 }),
      profile,
      [signal({ id: "prior", value: 0.017 })],
      Date.parse("2026-09-20T16:01:00Z")
    );
    expect(result.action).toBe("INVESTIGATE");
    expect(result.classification).toBe("anomaly");
  });

  it("does not treat normal recent samples as sustained anomaly evidence", () => {
    const result = evaluateSignal(
      signal({ value: 0.018, sustainedForSeconds: 300 }),
      profile,
      [signal({ id: "normal-prior", value: 0.0101 })],
      Date.parse("2026-09-20T16:01:00Z")
    );
    expect(result.action).toBe("MONITOR");
  });

  it("excludes future and cross-resource samples from sustained evidence", () => {
    const current = signal({
      value: 0.018,
      sustainedForSeconds: 300,
      scope: { portfolioId: "p1", companyId: "c1", resourceId: "r1" }
    });
    const result = evaluateSignal(
      current,
      profile,
      [
        signal({
          id: "other-resource",
          value: 0.018,
          scope: { portfolioId: "p1", companyId: "c1", resourceId: "r2" }
        }),
        signal({
          id: "future",
          value: 0.018,
          occurredAt: "2026-09-20T16:02:00Z",
          scope: { portfolioId: "p1", companyId: "c1", resourceId: "r1" }
        })
      ],
      Date.parse("2026-09-20T16:01:00Z")
    );
    expect(result.action).toBe("MONITOR");
  });

  it("rejects impossible zero-sample and sustained-window profiles", () => {
    expect(() => validateSensingProfile({ ...profile, minimumSamples: 0 })).toThrow();
    expect(() => validateSensingProfile({ ...profile, sustainedSeconds: 601 })).toThrow();
  });

  it("prefers a resource-specific baseline over the company fallback", async () => {
    const resolver = new ScopedSensingProfileResolver({
      listForCompany: async () => [
        profile,
        {
          ...profile,
          id: "resource-profile",
          resourceId: "r1",
          baselineValue: 0.005
        }
      ]
    });

    const resolved = await resolver.resolve(signal({
      scope: { portfolioId: "p1", companyId: "c1", resourceId: "r1" }
    }));

    expect(resolved?.id).toBe("resource-profile");
    expect(resolved?.baselineValue).toBe(0.005);
  });

  it("escalates critical resource vocabulary before expected-source downgrades", () => {
    const result = evaluateSignal(
      signal({ type: "resource.policy-violation", expected: true, severity: "info", scope: { portfolioId: "p1", companyId: "c1", resourceId: "r1" } }),
      null,
      [],
      Date.parse("2026-09-20T16:01:00Z")
    );
    expect(result.action).toBe("ESCALATE");
    expect(result.classification).toBe("incident");
  });

  it("records stale signals without opening expensive investigation", () => {
    const result = evaluateSignal(
      signal({ occurredAt: "2026-09-20T15:00:00Z", value: 1, sustainedForSeconds: 1000 }),
      profile,
      [],
      Date.parse("2026-09-20T16:01:00Z")
    );
    expect(result.action).toBe("RECORD");
  });

  it("rejects non-monotonic sensing thresholds", () => {
    expect(() => validateSensingProfile({
      ...profile,
      monitorDeviationRatio: 1,
      investigateDeviationRatio: 0.5
    })).toThrow();
  });

  it("creates one deterministic investigation and appends later matching signals", async () => {
    const store = new MemoryInvestigations();
    const coordinator = new InvestigationCoordinator(store, () => "investigation-1");
    const profiles: SensingProfileResolver = { resolve: async () => profile };
    const recentSignals: RecentSignalReader = {
      listRecent: async () => [signal({ id: "prior", value: 0.017 })]
    };
    const engine = new SensingEngine(profiles, recentSignals, coordinator);

    const first = await engine.process(
      signal({ value: 0.018, sustainedForSeconds: 300 }),
      new Date("2026-09-20T16:01:00Z")
    );
    expect(first.investigation.status).toBe("created");

    const second = await engine.process(
      signal({ id: "signal-2", eventId: "evt-2", dedupeKey: "dedupe-2", value: 0.019, sustainedForSeconds: 300 }),
      new Date("2026-09-20T16:02:00Z")
    );
    expect(second.investigation.status).toBe("updated");
    expect(store.latest?.signalIds).toEqual(["signal-1", "signal-2"]);
  });

  it("suppresses non-critical investigation recreation during cooldown", async () => {
    const store = new MemoryInvestigations();
    store.latest = {
      id: "old-investigation",
      key: "p1:c1:-:business.error-rate",
      portfolioId: "p1",
      companyId: "c1",
      signalType: "business.error-rate",
      state: "resolved",
      severity: "anomaly",
      action: "INVESTIGATE",
      signalIds: ["old-signal"],
      reason: "old event",
      openedAt: "2026-09-20T15:55:00Z",
      lastSignalAt: "2026-09-20T15:56:00Z",
      cooldownUntil: "2026-09-20T16:10:00Z",
      version: 2
    };

    const coordinator = new InvestigationCoordinator(store);
    const sensed = evaluateSignal(
      signal({ value: 0.018, sustainedForSeconds: 300 }),
      profile,
      [signal({ id: "prior", value: 0.017 })],
      Date.parse("2026-09-20T16:01:00Z")
    );

    const result = await coordinator.consider(sensed, { cooldownSeconds: 600 }, new Date("2026-09-20T16:01:00Z"));
    expect(result.status).toBe("cooldown-suppressed");
  });
});
