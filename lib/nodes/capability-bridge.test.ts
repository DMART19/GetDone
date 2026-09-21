import { describe, expect, it } from "vitest";
import type { NodeCapability } from "@/lib/nodes/contracts";
import { hashNodeCapability } from "@/lib/nodes/hashes";
import {
  deriveNodeCapabilityBindings,
  deriveNodeCapabilityReconciliationBindings,
  ResourceRegistryNodeCapabilityBridge
} from "@/lib/nodes/capability-bridge";

function capability(
  name: string,
  status: NodeCapability["status"],
  suffix = name
): NodeCapability {
  const base: Omit<NodeCapability, "capabilityHash"> = {
    id: `node-capability-${suffix.replaceAll(".", "-")}`,
    nodeId: "node-1",
    name,
    version: "1.0.0",
    status,
    evidenceIds: [`evidence-${suffix.replaceAll(".", "-")}`],
    constraints: {},
    observedAt: "2026-09-21T18:00:00Z"
  };
  return {
    ...base,
    capabilityHash: hashNodeCapability(base)
  };
}

describe("Phase 28.4 Capability Registry bridge", () => {
  it("maps either validated container runtime to one authoritative CPU capability", () => {
    const bindings = deriveNodeCapabilityBindings({
      resourceId: "resource-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      observedAt: "2026-09-21T18:00:00Z",
      capabilities: [
        capability("runtime.docker", "validated", "docker"),
        capability("runtime.containerd", "validated", "containerd")
      ]
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      capabilityName: "compute.cpu.light",
      adapterBinding: "resource.compute",
      validated: true
    });
    expect(bindings[0].evidenceIds).toContain("evidence-docker");
    expect(bindings[0].evidenceIds).toContain("evidence-containerd");
  });

  it("maps validated CUDA evidence to the existing GPU inference capability", () => {
    const bindings = deriveNodeCapabilityBindings({
      resourceId: "resource-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      observedAt: "2026-09-21T18:00:00Z",
      capabilities: [capability("gpu.cuda", "validated")]
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      capabilityName: "compute.gpu.inference",
      adapterBinding: "resource.compute"
    });
  });

  it("emits revocation evidence when a bridged local capability is downgraded", () => {
    const bindings = deriveNodeCapabilityReconciliationBindings({
      resourceId: "resource-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      observedAt: "2026-09-21T18:05:00Z",
      capabilities: [
        capability("runtime.docker", "detected"),
        capability("tool.git", "validated")
      ]
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      capabilityName: "compute.cpu.light",
      adapterBinding: "resource.compute",
      validated: false
    });
  });

  it("publishes bindings only through ResourceRegistryService authority", async () => {
    const calls: unknown[] = [];
    const bridge = new ResourceRegistryNodeCapabilityBridge({
      addCapabilityBinding: async (...args: unknown[]) => {
        calls.push(args);
        return args[1];
      }
    } as never);

    const bindings = await bridge.publish({
      node: {
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
      },
      environment: "development",
      observedAt: "2026-09-21T18:00:00Z",
      capabilities: [capability("runtime.docker", "validated")]
    });

    expect(bindings).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const [resourceId, binding, command] = calls[0] as [
      string,
      { validated: boolean; capabilityName: string },
      { provenance: string; scope: { environment: string } }
    ];
    expect(resourceId).toBe("resource-1");
    expect(binding).toMatchObject({
      capabilityName: "compute.cpu.light",
      validated: true
    });
    expect(command.provenance).toBe("node-capability-bridge");
    expect(command.scope.environment).toBe("development");
  });

  it("does not promote detected-only or unrelated local tools", () => {
    const bindings = deriveNodeCapabilityBindings({
      resourceId: "resource-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      observedAt: "2026-09-21T18:00:00Z",
      capabilities: [
        capability("runtime.docker", "detected"),
        capability("tool.git", "validated")
      ]
    });
    expect(bindings).toEqual([]);
  });
});
