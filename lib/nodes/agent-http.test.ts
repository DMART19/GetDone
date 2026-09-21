import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HardwareInventory } from "@/lib/nodes/contracts";
import { hashHardwareInventory } from "@/lib/nodes/hashes";
import { handleNodeInventory } from "@/lib/nodes/agent-http";
import {
  installNodeAgentAuthenticator,
  installNodeInventoryAdapter,
  resetNodeAgentAuthenticator,
  resetNodeInventoryAdapter
} from "@/lib/nodes/agent-runtime.server";

function payload(): HardwareInventory {
  const base = {
    nodeId: "node-1",
    platform: "linux" as const,
    architecture: "x86_64" as const,
    cpu: {
      architecture: "x86_64" as const,
      model: "Xeon",
      sockets: 1,
      physicalCores: 2,
      logicalThreads: 4,
      virtualizationSupported: true
    },
    memory: { totalBytes: 1024 },
    gpus: [],
    storage: [],
    network: [],
    operatingSystem: {
      distribution: "Ubuntu",
      version: "24.04",
      kernel: "6.8"
    },
    cgroups: { version: 2 as const, available: true },
    discoveredAt: "2026-09-21T12:00:00Z"
  };
  return {
    ...base,
    inventoryHash: hashHardwareInventory({ ...base, inventoryHash: "" } as HardwareInventory)
  };
}

function request(body: unknown, withKey = true) {
  const headers = new Headers({ "content-type": "application/json" });
  if (withKey) headers.set("idempotency-key", "inventory-submit-1");
  return new Request("http://localhost/api/agent/v1/inventory", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  process.env.GETDONE_RUNTIME_ENV = "development";
});

afterEach(() => {
  delete process.env.GETDONE_RUNTIME_ENV;
  resetNodeAgentAuthenticator();
  resetNodeInventoryAdapter();
});

describe("Node inventory HTTP boundary", () => {
  it("fails closed when authenticated Node transport is unconnected", async () => {
    const response = await handleNodeInventory(request(payload()));
    expect(response.status).toBe(503);
  });

  it("requires idempotency for inventory writes", async () => {
    installNodeAgentAuthenticator({
      authenticate: async () => ({
        nodeId: "node-1",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        credentialId: "credential-1"
      })
    });
    const response = await handleNodeInventory(request(payload(), false));
    expect(response.status).toBe(400);
  });

  it("persists only after authenticated Node identity is resolved", async () => {
    let received: HardwareInventory | undefined;
    installNodeAgentAuthenticator({
      authenticate: async () => ({
        nodeId: "node-1",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        credentialId: "credential-1"
      })
    });
    installNodeInventoryAdapter({
      submit: async (_principal, inventory) => {
        received = inventory;
        return {
          id: "inventory-1",
          nodeId: inventory.nodeId,
          portfolioId: "portfolio-a",
          companyId: "company-a",
          architecture: inventory.architecture,
          inventoryHash: inventory.inventoryHash,
          discoveredAt: inventory.discoveredAt,
          receivedAt: "2026-09-21T12:01:00Z",
          inventory
        };
      }
    });

    const response = await handleNodeInventory(request(payload()));
    expect(response.status).toBe(201);
    expect(received?.nodeId).toBe("node-1");
  });

  it("rejects unsupported architecture at the schema boundary", async () => {
    installNodeAgentAuthenticator({
      authenticate: async () => ({
        nodeId: "node-1",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        credentialId: "credential-1"
      })
    });
    const bad = { ...payload(), architecture: "riscv64" };
    const response = await handleNodeInventory(request(bad));
    expect(response.status).toBe(400);
  });
});
