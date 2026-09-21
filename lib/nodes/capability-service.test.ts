import { describe, expect, it } from "vitest";
import type {
  HardwareInventory,
  NodeCapability,
  NodeCapabilityProfile
} from "@/lib/nodes/contracts";
import {
  hashHardwareInventory,
  hashNodeCapability,
  hashNodeCapabilityProfile
} from "@/lib/nodes/hashes";
import type { NodeBootstrapRecord } from "@/lib/nodes/identity";
import {
  NodeCapabilityService
} from "@/lib/nodes/capability-service";
import type { NodeAgentPrincipal } from "@/lib/nodes/inventory-service";
import type { NodeInventoryRecord } from "@/lib/persistence/postgres/node-inventory-store";
import type {
  NodeCapabilityProfileRecord,
  NodeCapabilityReconciliationResult,
  NodeCapabilityStore
} from "@/lib/persistence/postgres/node-capability-store";

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
  resourceId: "resource-1",
  displayName: "Server",
  platform: "linux",
  architecture: "x86_64",
  agentVersion: "0.4.0-development",
  protocolVersion: "1.0.0",
  lifecycleState: "authenticated",
  version: 1,
  createdAt: "2026-09-21T17:00:00Z",
  updatedAt: "2026-09-21T17:00:00Z"
};

function hardware(withNvidia = true): HardwareInventory {
  const base: Omit<HardwareInventory, "inventoryHash"> = {
    nodeId: "node-1",
    platform: "linux",
    architecture: "x86_64",
    cpu: {
      architecture: "x86_64",
      model: "Xeon",
      sockets: 1,
      physicalCores: 8,
      logicalThreads: 16,
      virtualizationSupported: true
    },
    memory: { totalBytes: 32 * 1024 * 1024 * 1024 },
    gpus: withNvidia ? [{
      id: "gpu-nvidia-0",
      vendor: "nvidia",
      model: "RTX",
      computeCapabilities: ["cuda-compute-8.9"],
      health: "healthy"
    }] : [],
    storage: [],
    network: [],
    operatingSystem: {
      distribution: "Ubuntu",
      version: "24.04",
      kernel: "6.8"
    },
    cgroups: { version: 2, available: true },
    discoveredAt: "2026-09-21T17:30:00Z"
  };
  return {
    ...base,
    inventoryHash: hashHardwareInventory(base)
  };
}

function inventoryRecord(withNvidia = true): NodeInventoryRecord {
  const inventory = hardware(withNvidia);
  return {
    id: "inventory-1",
    nodeId: "node-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    architecture: "x86_64",
    inventoryHash: inventory.inventoryHash,
    discoveredAt: inventory.discoveredAt,
    receivedAt: "2026-09-21T17:31:00Z",
    inventory
  };
}

function capability(
  name: string,
  status: NodeCapability["status"] = "validated"
): NodeCapability {
  const base: Omit<NodeCapability, "capabilityHash"> = {
    id: `node-capability-${name.replaceAll(".", "-")}`,
    nodeId: "node-1",
    name,
    version: "1.0.0",
    status,
    evidenceIds: ["cap-evidence-1"],
    constraints: {},
    observedAt: "2026-09-21T18:00:00Z"
  };
  return {
    ...base,
    capabilityHash: hashNodeCapability(base)
  };
}

function profile(
  capabilities: readonly NodeCapability[]
): NodeCapabilityProfile {
  const base: Omit<NodeCapabilityProfile, "profileHash"> = {
    nodeId: "node-1",
    observedAt: "2026-09-21T18:00:00Z",
    capabilities
  };
  return {
    ...base,
    profileHash: hashNodeCapabilityProfile(base)
  };
}

class MemoryCapabilityStore implements NodeCapabilityStore {
  records: NodeCapabilityProfileRecord[] = [];
  current: NodeCapability[] = [];

  async replaceProfile(
    record: NodeCapabilityProfileRecord
  ): Promise<NodeCapabilityReconciliationResult> {
    this.records.push(record);
    this.current = [...record.profile.capabilities];
    return {
      profile: record,
      currentCapabilities: this.current,
      removedCapabilities: [],
      replay: false
    };
  }

  async listCurrent() {
    return this.current;
  }

  async getLatestProfile() {
    return this.records.at(-1) ?? null;
  }
}

function setup(
  options: {
    nodeRecord?: NodeBootstrapRecord | null;
    inventory?: NodeInventoryRecord | null;
  } = {}
) {
  const capabilities = new MemoryCapabilityStore();
  const nodeRecord = options.nodeRecord === undefined ? node : options.nodeRecord;
  const inventory = options.inventory === undefined
    ? inventoryRecord()
    : options.inventory;
  return {
    capabilities,
    service: new NodeCapabilityService({
      nodes: { get: async () => nodeRecord },
      inventories: { getLatest: async () => inventory },
      capabilities,
      now: () => new Date("2026-09-21T18:00:05Z")
    })
  };
}

describe("NodeCapabilityService", () => {
  it("accepts a supported hash-bound profile after authoritative inventory exists", async () => {
    const ctx = setup();
    const result = await ctx.service.submit(
      principal,
      profile([
        capability("runtime.docker"),
        capability("runtime.python")
      ])
    );
    expect(result.currentCapabilities).toHaveLength(2);
    expect(ctx.capabilities.records).toHaveLength(1);
  });

  it("rejects unsupported local capability names", async () => {
    const ctx = setup();
    await expect(ctx.service.submit(
      principal,
      profile([capability("runtime.unknown")])
    )).rejects.toThrow(/unsupported node capability/i);
  });

  it("rejects tampered capability and profile hashes", async () => {
    const ctx = setup();
    const badCapability = {
      ...capability("runtime.python"),
      capabilityHash: "0".repeat(64)
    };
    const badCapabilityProfile = profile([badCapability]);
    await expect(ctx.service.submit(principal, badCapabilityProfile))
      .rejects.toThrow(/capability hash is invalid/i);

    const badProfile = {
      ...profile([capability("runtime.python")]),
      profileHash: "0".repeat(64)
    };
    await expect(ctx.service.submit(principal, badProfile))
      .rejects.toThrow(/profile canonical hash is invalid/i);
  });

  it("requires authoritative inventory before accepting capability evidence", async () => {
    const ctx = setup({ inventory: null });
    await expect(ctx.service.submit(
      principal,
      profile([capability("runtime.python")])
    )).rejects.toThrow(/inventory is required/i);
  });

  it("rejects CUDA spoofing when authoritative inventory has no NVIDIA GPU", async () => {
    const ctx = setup({ inventory: inventoryRecord(false) });
    await expect(ctx.service.submit(
      principal,
      profile([capability("gpu.cuda")])
    )).rejects.toThrow(/inconsistent with authoritative hardware inventory/i);
  });

  it("rejects cross-company Node scope and agent-submitted disabled state", async () => {
    const crossScope = setup({
      nodeRecord: { ...node, companyId: "company-b" }
    });
    await expect(crossScope.service.submit(
      principal,
      profile([capability("runtime.python")])
    )).rejects.toThrow(/not found/i);

    const ctx = setup();
    await expect(ctx.service.submit(
      principal,
      profile([capability("runtime.python", "disabled")])
    )).rejects.toThrow(/only detected or validated/i);
  });
});
