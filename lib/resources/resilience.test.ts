import { describe, expect, it } from "vitest";
import {
  beginDrain,
  createFailureDomainSnapshot,
  createFailoverPlan,
  createFailoverVerificationEvidence,
  createInitialFailoverRecord,
  evaluateFailureDomainAdmission,
  transitionFailover,
  updateDrain
} from "@/lib/resources/resilience";

function domain(overrides: Partial<Parameters<typeof createFailureDomainSnapshot>[0]> = {}) {
  return createFailureDomainSnapshot({
    id: "provider-a",
    portfolioId: "p1",
    companyId: "c1",
    kind: "provider",
    parentDomainIds: [],
    health: "healthy",
    circuitBreaker: "closed",
    allowExistingWork: true,
    observedAt: "2026-09-20T22:00:00Z",
    expiresAt: "2026-09-20T23:00:00Z",
    ...overrides
  });
}

describe("Phase 37 resilience orchestrator contracts", () => {
  it("blocks new placement when a correlated failure domain is degraded", () => {
    const admission = evaluateFailureDomainAdmission({
      targetId: "pool-a",
      domains: [domain({ health: "degraded" })],
      evaluatedAt: "2026-09-20T22:10:00Z"
    });
    expect(admission.admittedForNewWork).toBe(false);
    expect(admission.keepExistingWork).toBe(true);
  });

  it("circuit-open domains block new placement even when provider self-reports healthy", () => {
    const admission = evaluateFailureDomainAdmission({
      targetId: "pool-a",
      domains: [domain({ circuitBreaker: "open" })],
      evaluatedAt: "2026-09-20T22:10:00Z"
    });
    expect(admission.admittedForNewWork).toBe(false);
    expect(admission.reasons).toContain("circuit-open:provider-a");
  });

  it("drains without evicting existing work and reaches drained only at zero", () => {
    const draining = beginDrain({
      id: "drain-1",
      scope: { portfolioId: "p1", companyId: "c1", environment: "production" },
      target: { type: "resource", id: "pi-1" },
      reason: "maintenance",
      runningWork: 2,
      startedAt: "2026-09-20T22:00:00Z"
    });
    const stillDraining = updateDrain({
      current: draining,
      remainingWork: 1,
      updatedAt: "2026-09-20T22:01:00Z"
    });
    expect(stillDraining.state).toBe("draining");
    expect(updateDrain({
      current: stillDraining,
      remainingWork: 0,
      updatedAt: "2026-09-20T22:02:00Z"
    }).state).toBe("drained");
  });

  it("prevents drain work or time from moving backwards", () => {
    const draining = beginDrain({
      id: "drain-monotonic",
      scope: { portfolioId: "p1", companyId: "c1", environment: "production" },
      target: { type: "resource", id: "pi-1" },
      reason: "maintenance",
      runningWork: 2,
      startedAt: "2026-09-20T22:00:00Z"
    });
    expect(() => updateDrain({
      current: draining,
      remainingWork: 3,
      updatedAt: "2026-09-20T22:01:00Z"
    })).toThrow(/cannot increase/i);
    expect(() => updateDrain({
      current: draining,
      remainingWork: 1,
      updatedAt: "2026-09-20T21:59:00Z"
    })).toThrow(/cannot move backwards/i);
  });

  it("requires failover to escape the same failure domain", () => {
    expect(() => createFailoverPlan({
      id: "failover-1",
      scope: { portfolioId: "p1", companyId: "c1", environment: "production" },
      jobId: "job-1",
      source: { type: "resource", id: "pi-1" },
      target: { type: "resource", id: "pi-2" },
      sourceFailureDomainIds: ["home-site"],
      targetFailureDomainIds: ["home-site"],
      reason: "source unreachable",
      retryable: true,
      checkpointAware: false,
      estimatedTemporaryCostImpactCents: 25,
      createdAt: "2026-09-20T22:00:00Z"
    })).toThrow(/correlated/i);
  });

  it("never claims recovery from dispatch/provider success alone", () => {
    const plan = createFailoverPlan({
      id: "failover-2",
      scope: { portfolioId: "p1", companyId: "c1", environment: "production" },
      jobId: "job-1",
      source: { type: "resource", id: "pi-1" },
      target: { type: "resource", id: "cloud-1" },
      sourceFailureDomainIds: ["home-site"],
      targetFailureDomainIds: ["cloud-region"],
      reason: "source unreachable",
      retryable: true,
      checkpointAware: false,
      estimatedTemporaryCostImpactCents: 25,
      createdAt: "2026-09-20T22:00:00Z"
    });
    let record = createInitialFailoverRecord(plan);
    record = transitionFailover({ current: record, to: "authorized", updatedAt: "2026-09-20T22:01:00Z" });
    record = transitionFailover({ current: record, to: "dispatching", updatedAt: "2026-09-20T22:02:00Z" });
    record = transitionFailover({
      current: record,
      to: "verifying",
      dispatchEvidenceId: "provider-accepted",
      updatedAt: "2026-09-20T22:03:00Z"
    });
    expect(record.authoritativeRecoveryClaimed).toBe(false);
    expect(() => transitionFailover({
      current: record,
      to: "verified",
      updatedAt: "2026-09-20T22:04:00Z",
      postFailoverHealth: "healthy"
    })).toThrow(/verification evidence/i);
  });

  it("claims recovery only with verification receipt plus healthy post-failover state", () => {
    const plan = createFailoverPlan({
      id: "failover-3",
      scope: { portfolioId: "p1", companyId: "c1", environment: "production" },
      source: { type: "pool", id: "pool-a" },
      target: { type: "pool", id: "pool-b" },
      sourceFailureDomainIds: ["provider-a"],
      targetFailureDomainIds: ["provider-b"],
      reason: "provider degradation",
      retryable: false,
      checkpointAware: true,
      estimatedTemporaryCostImpactCents: 100,
      createdAt: "2026-09-20T22:00:00Z"
    });
    let record = createInitialFailoverRecord(plan);
    record = transitionFailover({ current: record, to: "authorized", updatedAt: "2026-09-20T22:01:00Z" });
    record = transitionFailover({ current: record, to: "dispatching", updatedAt: "2026-09-20T22:02:00Z" });
    record = transitionFailover({
      current: record,
      to: "verifying",
      dispatchEvidenceId: "dispatch-evidence",
      updatedAt: "2026-09-20T22:03:00Z"
    });
    const verificationEvidence = createFailoverVerificationEvidence({
      planId: plan.id,
      planHash: plan.planHash,
      dispatchEvidenceId: "dispatch-evidence",
      verificationReceiptId: "verify-1",
      verificationReceiptHash: "verified-hash",
      postFailoverHealth: "healthy",
      observedAt: "2026-09-20T22:03:30Z"
    });
    record = transitionFailover({
      current: record,
      to: "verified",
      verificationEvidence,
      updatedAt: "2026-09-20T22:04:00Z"
    });
    expect(record.state).toBe("verified");
    expect(record.authoritativeRecoveryClaimed).toBe(true);
    expect(record.verificationEvidenceHash).toBe(verificationEvidence.evidenceHash);
  });

  it("rejects verification evidence from the wrong failover lineage", () => {
    const plan = createFailoverPlan({
      id: "failover-lineage",
      scope: { portfolioId: "p1", companyId: "c1", environment: "production" },
      source: { type: "pool", id: "pool-a" },
      target: { type: "pool", id: "pool-b" },
      sourceFailureDomainIds: ["provider-a"],
      targetFailureDomainIds: ["provider-b"],
      reason: "provider degradation",
      retryable: true,
      checkpointAware: false,
      estimatedTemporaryCostImpactCents: 50,
      createdAt: "2026-09-20T22:00:00Z"
    });
    let record = createInitialFailoverRecord(plan);
    record = transitionFailover({ current: record, to: "authorized", updatedAt: "2026-09-20T22:01:00Z" });
    record = transitionFailover({ current: record, to: "dispatching", updatedAt: "2026-09-20T22:02:00Z" });
    record = transitionFailover({
      current: record,
      to: "verifying",
      dispatchEvidenceId: "dispatch-good",
      updatedAt: "2026-09-20T22:03:00Z"
    });
    const forged = createFailoverVerificationEvidence({
      planId: plan.id,
      planHash: plan.planHash,
      dispatchEvidenceId: "dispatch-other",
      verificationReceiptId: "verify-2",
      verificationReceiptHash: "verified-hash-2",
      postFailoverHealth: "healthy",
      observedAt: "2026-09-20T22:03:30Z"
    });
    expect(() => transitionFailover({
      current: record,
      to: "verified",
      verificationEvidence: forged,
      updatedAt: "2026-09-20T22:04:00Z"
    })).toThrow(/lineage/i);
  });
});
