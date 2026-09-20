import { describe, expect, it } from "vitest";
import {
  assertResourcePoolEligible,
  buildResourcePoolReadModel,
  createGovernedResourcePool,
  createResourcePoolCapacitySnapshot,
  evaluateResourcePoolReadiness
} from "@/lib/resources/pools";

function pool(overrides: Partial<Parameters<typeof createGovernedResourcePool>[0]> = {}) {
  return createGovernedResourcePool({
    id: "dc-west",
    portfolioId: "p1",
    companyId: "c1",
    displayName: "DC West",
    providerId: "partner-west",
    adapterId: "partner-adapter",
    adapterVersion: "1.0.0",
    state: "ready",
    environmentPermissions: ["staging", "production"],
    capabilityClasses: ["compute.cpu.light", "storage.backup"],
    dataClassesAllowed: ["INTERNAL", "CUSTOMER"],
    reliabilityTier: "HIGH",
    region: "us-west",
    failureDomainIds: ["partner-dc-west", "provider-partner-west"],
    credentialBindingIds: ["credential-binding:partner-west"],
    policyBindingIds: ["policy:partner-west"],
    autoSchedulingEnabled: true,
    createdAt: "2026-09-20T22:00:00Z",
    updatedAt: "2026-09-20T22:00:00Z",
    version: 1,
    ...overrides
  });
}

const evidence = {
  adapterAuthenticated: true,
  identityVerified: true,
  capabilitiesValidated: true,
  healthVerified: true,
  aggregateCapacityVerified: true,
  failureDomainsVerified: true,
  costModelVerified: true,
  credentialBindingsScoped: true
};

describe("Phase 39 governed aggregate ResourcePool", () => {
  it("requires full governance evidence before a pool is ready", () => {
    const readiness = evaluateResourcePoolReadiness({
      pool: pool(),
      evidence: { ...evidence, credentialBindingsScoped: false }
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.reasons).toContain("pool-credentials-not-scoped");
  });

  it("keeps pool usage within total/quota/protected capacity", () => {
    const snapshot = createResourcePoolCapacitySnapshot({
      poolId: "dc-west",
      totalCapacity: { cpu: 100 },
      usedCapacity: { cpu: 50 },
      reservedCapacity: { cpu: 20 },
      protectedHeadroom: { cpu: 10 },
      quotaCapacity: { cpu: 120 },
      currentWorkloadIds: ["job-a", "job-b"],
      observedAt: "2026-09-20T22:00:00Z",
      expiresAt: "2026-09-20T23:00:00Z"
    });
    expect(snapshot.snapshotHash).toHaveLength(64);
  });

  it("rejects cross-company and disallowed data-class scheduling", () => {
    const p = pool();
    const readiness = evaluateResourcePoolReadiness({ pool: p, evidence });
    expect(() => assertResourcePoolEligible({
      pool: p,
      scope: { portfolioId: "p1", companyId: "c2", environment: "production" },
      dataClass: "CUSTOMER",
      capability: "compute.cpu.light",
      readiness
    })).toThrow(/trusted scope/i);
    expect(() => assertResourcePoolEligible({
      pool: p,
      scope: { portfolioId: "p1", companyId: "c1", environment: "production" },
      dataClass: "SENSITIVE",
      capability: "compute.cpu.light",
      readiness
    })).toThrow(/data policy/i);
  });

  it("exposes one concise aggregate read model instead of forcing node inventory", () => {
    const p = pool();
    const readiness = evaluateResourcePoolReadiness({ pool: p, evidence });
    const capacity = createResourcePoolCapacitySnapshot({
      poolId: p.id,
      totalCapacity: { cpu: 100, memoryGb: 512 },
      usedCapacity: { cpu: 40, memoryGb: 200 },
      reservedCapacity: { cpu: 10, memoryGb: 50 },
      protectedHeadroom: { cpu: 20, memoryGb: 100 },
      currentWorkloadIds: ["job-a", "job-b"],
      observedAt: "2026-09-20T22:00:00Z",
      expiresAt: "2026-09-20T23:00:00Z"
    });
    const read = buildResourcePoolReadModel({
      pool: p,
      capacity,
      readiness,
      estimatedHourlyCents: 250,
      evaluatedAt: "2026-09-20T22:10:00Z"
    });
    expect(read.displayName).toBe("DC West");
    expect(read.currentWorkloadCount).toBe(2);
    expect(read.utilization.cpu).toBe(0.4);
    expect(read.costSummary).toContain("250");
  });

  it("fails closed when aggregate capacity snapshots go stale", () => {
    const p = pool();
    const readiness = evaluateResourcePoolReadiness({ pool: p, evidence });
    const capacity = createResourcePoolCapacitySnapshot({
      poolId: p.id,
      totalCapacity: { cpu: 100 },
      usedCapacity: { cpu: 40 },
      reservedCapacity: { cpu: 10 },
      protectedHeadroom: { cpu: 20 },
      currentWorkloadIds: [],
      observedAt: "2026-09-20T22:00:00Z",
      expiresAt: "2026-09-20T22:05:00Z"
    });
    expect(() => buildResourcePoolReadModel({
      pool: p,
      capacity,
      readiness,
      evaluatedAt: "2026-09-20T22:10:00Z"
    })).toThrow(/stale/i);
  });
});
