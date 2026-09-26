import { describe, expect, it } from "vitest";
import type { OutcomeRecord } from "@/lib/domain/services/outcome-service";
import {
  createConsequentialOutcomeSnapshot,
  createOutcomeReconciliationJob,
  OutcomeReconciliationService,
  type OutcomeReconciliationJob,
  type OutcomeReconciliationStore
} from "@/lib/execution/outcome-reconciliation";
import {
  InvestigationCoordinator,
  type Investigation,
  type InvestigationStore
} from "@/lib/intelligence/investigations";
import type { SensedSignal } from "@/lib/intelligence/signals";

const outcome: OutcomeRecord = Object.freeze({
  id: "outcome-1",
  correlationId: "corr-1",
  portfolioId: "portfolio",
  companyId: "company",
  version: 4,
  updatedAt: "2026-09-26T15:00:00Z",
  state: "verified",
  jobId: "job-1",
  metric: "gmail.message.sent",
  value: true,
  evidenceIds: ["provider-evidence-1"],
  verificationReceiptId: "verify-1",
  verificationReceiptHash: "verify-hash-1"
});

class MemoryReconciliationStore implements OutcomeReconciliationStore {
  checks: Array<Parameters<OutcomeReconciliationStore["recordCheck"]>[0]> = [];

  constructor(readonly jobs: readonly OutcomeReconciliationJob[]) {}

  async listDue() {
    return this.jobs;
  }

  async recordCheck(input: Parameters<OutcomeReconciliationStore["recordCheck"]>[0]) {
    this.checks.push(input);
  }
}

class MemoryInvestigationStore implements InvestigationStore {
  value: Investigation | null = null;

  async findLatestByKey() {
    return this.value;
  }

  async create(investigation: Investigation) {
    this.value = investigation;
  }

  async appendSignal(input: {
    investigationId: string;
    signalId: string;
    lastSignalAt: string;
    severity: Investigation["severity"];
    action: Investigation["action"];
    expectedVersion: number;
  }) {
    if (!this.value || this.value.id !== input.investigationId) throw new Error("missing investigation");
    this.value = {
      ...this.value,
      signalIds: [...this.value.signalIds, input.signalId],
      lastSignalAt: input.lastSignalAt,
      severity: input.severity,
      action: input.action,
      version: input.expectedVersion + 1
    };
    return this.value;
  }
}

function registration(expectedExternalStateHash = "external-hash-1") {
  const snapshot = createConsequentialOutcomeSnapshot({
    outcome,
    expectedExternalStateHash,
    recordedAt: "2026-09-26T15:01:00Z"
  });
  return createOutcomeReconciliationJob({
    id: "reconcile-1",
    snapshot,
    actionKind: "gmail.send",
    externalSubject: "gmail:message-1",
    intervalSeconds: 3600,
    firstCheckAt: "2026-09-26T16:00:00Z"
  });
}

describe("OutcomeReconciliationService", () => {
  it("registers only verified Outcome truth with original receipt lineage", () => {
    const snapshot = createConsequentialOutcomeSnapshot({
      outcome,
      expectedExternalStateHash: "external-hash-1",
      recordedAt: "2026-09-26T15:01:00Z"
    });
    expect(snapshot).toMatchObject({
      outcomeId: outcome.id,
      outcomeState: "verified",
      verificationReceiptId: "verify-1",
      verificationReceiptHash: "verify-hash-1",
      expectedExternalStateHash: "external-hash-1"
    });

    expect(() => createConsequentialOutcomeSnapshot({
      outcome: { ...outcome, state: "uncertain" },
      expectedExternalStateHash: "external-hash-1",
      recordedAt: "2026-09-26T15:01:00Z"
    })).toThrow(/verified completed Outcomes/i);
  });

  it("periodically records a consistent re-check without emitting drift", async () => {
    const job = registration();
    const store = new MemoryReconciliationStore([job]);
    const signals: SensedSignal[] = [];
    const investigationStore = new MemoryInvestigationStore();
    const service = new OutcomeReconciliationService({
      store,
      probe: {
        observe: async () => ({
          observedAt: "2026-09-26T16:00:00Z",
          externalStateHash: "external-hash-1",
          evidenceIds: ["gmail-get-1"],
          provenance: "gmail:messages.get"
        })
      },
      signals: { append: async (signal) => { signals.push(signal); } },
      investigations: new InvestigationCoordinator(investigationStore, () => "investigation-1"),
      investigationPolicy: { cooldownSeconds: 3600 },
      now: () => new Date("2026-09-26T16:00:00Z"),
      idFactory: () => "signal-1"
    });

    const result = await service.runDue();
    expect(result).toEqual([{ jobId: "reconcile-1", result: "consistent" }]);
    expect(signals).toHaveLength(0);
    expect(investigationStore.value).toBeNull();
    expect(store.checks[0]).toMatchObject({
      result: "consistent",
      observedStateHash: "external-hash-1",
      nextCheckAt: "2026-09-26T17:00:00.000Z"
    });
  });

  it("records drift as a new Signal/Investigation without mutating historical Outcome truth", async () => {
    const before = JSON.stringify(outcome);
    const job = registration();
    const store = new MemoryReconciliationStore([job]);
    const signals: SensedSignal[] = [];
    const investigationStore = new MemoryInvestigationStore();
    const service = new OutcomeReconciliationService({
      store,
      probe: {
        observe: async () => ({
          observedAt: "2026-09-26T16:00:00Z",
          externalStateHash: "external-hash-drifted",
          evidenceIds: ["gmail-get-2"],
          provenance: "gmail:messages.get"
        })
      },
      signals: { append: async (signal) => { signals.push(signal); } },
      investigations: new InvestigationCoordinator(investigationStore, () => "investigation-1"),
      investigationPolicy: { cooldownSeconds: 3600 },
      now: () => new Date("2026-09-26T16:00:00Z"),
      idFactory: () => "signal-1"
    });

    const [result] = await service.runDue();
    expect(result.result).toBe("discrepant");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      id: "signal-1",
      type: "outcome.external-state-drift",
      classification: "risk",
      action: "INVESTIGATE",
      scope: { portfolioId: "portfolio", companyId: "company" }
    });
    expect(investigationStore.value).toMatchObject({
      id: "investigation-1",
      signalType: "outcome.external-state-drift",
      state: "open"
    });
    expect(store.checks[0]).toMatchObject({
      result: "discrepant",
      signalId: "signal-1",
      investigationId: "investigation-1",
      observedStateHash: "external-hash-drifted"
    });

    expect(JSON.stringify(outcome)).toBe(before);
    expect(outcome.state).toBe("verified");
    expect(outcome.verificationReceiptHash).toBe("verify-hash-1");
  });
});
