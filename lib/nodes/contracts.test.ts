import { describe, expect, it } from "vitest";
import {
  NODE_AGENT_PROTOCOL_VERSION,
  NODE_DOMAIN_VERSION,
  type HardwareInventory,
  type NodeArchitecture,
  type NodeRecord
} from "@/lib/nodes/contracts";

describe("Phase 28 universal compute node contracts", () => {
  it("versions the node domain and agent protocol independently", () => {
    expect(NODE_DOMAIN_VERSION).toBe("1.0.0");
    expect(NODE_AGENT_PROTOCOL_VERSION).toBe("1.0.0");
  });

  it("treats x86-64 and ARM64 as peer authoritative architectures", () => {
    const architectures: readonly NodeArchitecture[] = ["x86_64", "arm64"];
    expect(architectures).toEqual(["x86_64", "arm64"]);

    const base = {
      id: "node-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      resourceId: "resource-1",
      displayName: "Compute Node",
      platform: "linux",
      agentVersion: "0.0.0",
      protocolVersion: NODE_AGENT_PROTOCOL_VERSION,
      state: "identified",
      trustClass: "untrusted",
      environmentPermissions: ["development"],
      failureDomainIds: [],
      policyBindingIds: [],
      credentialBindingIds: [],
      capabilityProfileId: "capabilities-1",
      allocatableProfileId: "allocatable-1",
      createdAt: "2026-09-21T10:00:00Z",
      updatedAt: "2026-09-21T10:00:00Z",
      version: 1
    } as const;

    const x86 = { ...base, architecture: "x86_64" } satisfies NodeRecord;
    const arm = { ...base, id: "node-2", architecture: "arm64" } satisfies NodeRecord;
    expect([x86.architecture, arm.architecture]).toEqual(["x86_64", "arm64"]);
  });

  it("keeps physical inventory separate from any allocatable scheduler profile", () => {
    const inventory = {
      nodeId: "node-1",
      platform: "linux",
      architecture: "arm64",
      cpu: {
        architecture: "arm64",
        model: "reference-arm64",
        sockets: 1,
        physicalCores: 4,
        logicalThreads: 4,
        virtualizationSupported: false
      },
      memory: { totalBytes: 8_000_000_000 },
      gpus: [],
      storage: [],
      network: [],
      operatingSystem: {
        distribution: "linux",
        version: "1",
        kernel: "6.x"
      },
      cgroups: { version: 2, available: true },
      discoveredAt: "2026-09-21T10:00:00Z",
      inventoryHash: "0".repeat(64)
    } satisfies HardwareInventory;

    expect(inventory.memory.totalBytes).toBe(8_000_000_000);
    expect("cpuMillicores" in inventory).toBe(false);
  });
});
