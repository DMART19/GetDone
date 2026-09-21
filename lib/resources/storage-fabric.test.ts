import { describe, expect, it } from "vitest";
import {
  createStorageCopyPlan,
  createStorageDataObject,
  createStorageResourceSnapshot,
  evaluateStoragePlacement
} from "@/lib/resources/storage-fabric";

const object = createStorageDataObject({
  id: "orders-db",
  scope: { portfolioId: "p1", companyId: "c1", environment: "production" },
  dataClass: "PRODUCTION_CRITICAL",
  authoritative: true,
  rebuildable: false,
  retentionDays: 30,
  replicationFactor: 2,
  recoveryPointObjectiveSeconds: 60,
  recoveryTimeObjectiveSeconds: 300
});

function storage(
  id: string,
  locationClass: "HOME" | "CLOUD",
  failureDomainId: string | readonly string[]
) {
  return createStorageResourceSnapshot({
    id,
    portfolioId: "p1",
    companyId: "c1",
    environmentPermissions: ["production"],
    locationClass,
    region: "us-west",
    failureDomainIds: typeof failureDomainId === "string" ? [failureDomainId] : failureDomainId,
    reliabilityTier: locationClass === "HOME" ? "STANDARD" : "HIGH",
    capacityBytes: 1_000_000,
    availableBytes: 900_000,
    encryptedAtRest: true,
    encryptedInTransit: true,
    durabilityClass: "durable",
    supportsAuthoritative: true,
    supportsBackup: true,
    supportsArchive: true,
    recoveryPointObjectiveSeconds: 30,
    recoveryTimeObjectiveSeconds: 120,
    state: "ready",
    observedAt: "2026-09-20T22:00:00Z",
    expiresAt: "2026-09-20T23:00:00Z"
  });
}

describe("Phase 36 Storage Fabric", () => {
  it("rejects HOME as unqualified production authority", () => {
    const result = evaluateStoragePlacement({
      object,
      candidate: storage("nas-home", "HOME", "home-site"),
      requiredBytes: 1000,
      role: "authoritative-primary",
      evaluatedAt: "2026-09-20T22:10:00Z"
    });
    expect(result.eligible).toBe(false);
    expect(result.rejectionReasons).toContain("home-cannot-be-unqualified-production-authority");
  });

  it("allows HOME for approved secondary non-authoritative/rebuildable use", () => {
    const cacheObject = createStorageDataObject({
      id: "build-cache",
      scope: { portfolioId: "p1", companyId: "c1", environment: "production" },
      dataClass: "REBUILDABLE",
      authoritative: false,
      rebuildable: true,
      retentionDays: 7,
      replicationFactor: 1,
      recoveryPointObjectiveSeconds: 3600,
      recoveryTimeObjectiveSeconds: 7200
    });
    const result = evaluateStoragePlacement({
      object: cacheObject,
      candidate: storage("nas-home", "HOME", "home-site"),
      requiredBytes: 1000,
      role: "cache",
      evaluatedAt: "2026-09-20T22:10:00Z"
    });
    expect(result.eligible).toBe(true);
  });

  it("requires authoritative replication across distinct failure domains", () => {
    const cloudA = storage("cloud-a", "CLOUD", "region-a");
    const cloudB = storage("cloud-b", "CLOUD", "region-a");
    expect(() => createStorageCopyPlan({
      id: "plan-1",
      object,
      selections: [
        { candidate: cloudA, role: "authoritative-primary" },
        { candidate: cloudB, role: "authoritative-secondary" }
      ],
      requiredBytes: 1000,
      createdAt: "2026-09-20T22:10:00Z"
    })).toThrow(/distinct failure domains/i);
  });

  it("rejects replicas that share any correlated failure domain", () => {
    expect(() => createStorageCopyPlan({
      id: "plan-correlated",
      object,
      selections: [
        {
          candidate: storage("cloud-a", "CLOUD", ["provider-a", "region-a"]),
          role: "authoritative-primary"
        },
        {
          candidate: storage("cloud-b", "CLOUD", ["provider-a", "region-b"]),
          role: "authoritative-secondary"
        }
      ],
      requiredBytes: 1000,
      createdAt: "2026-09-20T22:10:00Z"
    })).toThrow(/correlated failure domain/i);
  });

  it("rejects fake replication that substitutes cache copies for authoritative replicas", () => {
    expect(() => createStorageCopyPlan({
      id: "plan-fake-replication",
      object,
      selections: [
        { candidate: storage("cloud-a", "CLOUD", "region-a"), role: "authoritative-primary" },
        { candidate: storage("cloud-b", "CLOUD", "region-b"), role: "cache" }
      ],
      requiredBytes: 1000,
      createdAt: "2026-09-20T22:10:00Z"
    })).toThrow(/authoritative replication factor/i);
  });

  it("requires exactly one authoritative primary", () => {
    expect(() => createStorageCopyPlan({
      id: "plan-two-primaries",
      object,
      selections: [
        { candidate: storage("cloud-a", "CLOUD", "region-a"), role: "authoritative-primary" },
        { candidate: storage("cloud-b", "CLOUD", "region-b"), role: "authoritative-primary" }
      ],
      requiredBytes: 1000,
      createdAt: "2026-09-20T22:10:00Z"
    })).toThrow(/exactly one authoritative primary/i);
  });

  it("creates a valid explainable authoritative copy plan outside HOME", () => {
    const plan = createStorageCopyPlan({
      id: "plan-2",
      object,
      selections: [
        { candidate: storage("cloud-a", "CLOUD", "region-a"), role: "authoritative-primary" },
        { candidate: storage("cloud-b", "CLOUD", "region-b"), role: "authoritative-secondary" }
      ],
      requiredBytes: 1000,
      createdAt: "2026-09-20T22:10:00Z"
    });
    expect(plan.authoritativeCopyCount).toBe(2);
    expect(plan.distinctFailureDomainCount).toBe(2);
    expect(plan.planHash).toHaveLength(64);
  });

  it("fails closed on stale storage snapshots", () => {
    const stale = storage("cloud-a", "CLOUD", "region-a");
    const result = evaluateStoragePlacement({
      object,
      candidate: stale,
      requiredBytes: 1000,
      role: "authoritative-primary",
      evaluatedAt: "2026-09-21T00:00:00Z"
    });
    expect(result.rejectionReasons).toContain("snapshot-stale-or-future");
  });
});
