import { describe, expect, it } from "vitest";
import type { HardwareInventory } from "@/lib/nodes/contracts";
import { hashHardwareInventory } from "@/lib/nodes/hashes";
import {
  NodeInventoryService,
  type NodeAgentPrincipal
} from "@/lib/nodes/inventory-service";
import type { NodeBootstrapRecord } from "@/lib/nodes/identity";
import type {
  NodeInventoryRecord,
  NodeInventoryStore
} from "@/lib/persistence/postgres/node-inventory-store";

const principal: NodeAgentPrincipal = {
  nodeId: "node-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  credentialId: "credential-1"
};

const node: NodeBootstrapRecord = {
  id: "node-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  ownerUserId: "owner-a",
  resourceEnrollmentId: "enrollment-1",
  displayName: "Server",
  platform: "linux",
  architecture: "x86_64",
  agentVersion: "0.3.0-development",
  protocolVersion: "1.0.0",
  lifecycleState: "authenticated",
  version: 1,
  createdAt: "2026-09-21T12:00:00Z",
  updatedAt: "2026-09-21T12:00:00Z"
};

function inventory(overrides: Partial<HardwareInventory> = {}): HardwareInventory {
  const base: Omit<HardwareInventory, "inventoryHash"> = {
    nodeId: "node-1",
    platform: "linux",
    architecture: "x86_64",
    cpu: {
      architecture: "x86_64",
      vendor: "GenuineIntel",
      model: "Xeon",
      sockets: 1,
      physicalCores: 4,
      logicalThreads: 8,
      virtualizationSupported: true
    },
    memory: { totalBytes: 16 * 1024 * 1024 * 1024, numaNodes: 1 },
    gpus: [],
    storage: [],
    network: [],
    operatingSystem: {
      distribution: "Ubuntu",
      version: "24.04",
      kernel: "6.8.0"
    },
    cgroups: { version: 2, available: true },
    discoveredAt: "2026-09-21T12:05:00Z",
    ...overrides
  };
  const complete = {
    ...base,
    inventoryHash: ""
  } as HardwareInventory;
  return {
    ...complete,
    inventoryHash: hashHardwareInventory(complete)
  };
}

class MemoryInventoryStore implements NodeInventoryStore {
  records: NodeInventoryRecord[] = [];
  async put(record: NodeInventoryRecord) {
    const existing = this.records.find(
      (candidate) =>
        candidate.nodeId === record.nodeId
        && candidate.inventoryHash === record.inventoryHash
    );
    if (existing) return existing;
    this.records.push(record);
    return record;
  }
  async getLatest(nodeId: string) {
    return [...this.records].reverse().find((record) => record.nodeId === nodeId) ?? null;
  }
}

function serviceFor(nodeRecord: NodeBootstrapRecord | null = node) {
  const inventories = new MemoryInventoryStore();
  return {
    inventories,
    service: new NodeInventoryService({
      nodes: { get: async () => nodeRecord },
      inventories,
      now: () => new Date("2026-09-21T12:06:00Z")
    })
  };
}

describe("NodeInventoryService", () => {
  it("accepts a hash-bound scoped inventory and idempotently replays it", async () => {
    const setup = serviceFor();
    const payload = inventory();
    const first = await setup.service.submit(principal, payload);
    const replay = await setup.service.submit(principal, payload);
    expect(first.inventoryHash).toBe(payload.inventoryHash);
    expect(replay.id).toBe(first.id);
    expect(setup.inventories.records).toHaveLength(1);
  });

  it("rejects node identity mismatch", async () => {
    const setup = serviceFor();
    await expect(setup.service.submit(principal, inventory({ nodeId: "node-2" })))
      .rejects.toThrow(/identity does not match/i);
  });

  it("rejects canonical hash tampering", async () => {
    const setup = serviceFor();
    const payload = { ...inventory(), inventoryHash: "0".repeat(64) };
    await expect(setup.service.submit(principal, payload))
      .rejects.toThrow(/canonical hash is invalid/i);
  });

  it("rejects architecture mismatch against enrolled identity", async () => {
    const setup = serviceFor();
    const payload = inventory({
      architecture: "arm64",
      cpu: {
        architecture: "arm64",
        model: "Neoverse",
        sockets: 1,
        physicalCores: 4,
        logicalThreads: 4,
        virtualizationSupported: false
      }
    });
    await expect(setup.service.submit(principal, payload))
      .rejects.toThrow(/architecture does not match enrollment/i);
  });

  it("fails closed on cross-company or missing enrolled Node state", async () => {
    const setup = serviceFor({
      ...node,
      companyId: "company-b"
    });
    await expect(setup.service.submit(principal, inventory()))
      .rejects.toThrow(/not found/i);

    const absent = serviceFor(null);
    await expect(absent.service.submit(principal, inventory()))
      .rejects.toThrow(/not found/i);
  });
});
