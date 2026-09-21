import { describe, expect, it } from "vitest";
import {
  assertNodeDispatchIntegrity,
  hashHardwareInventory,
  hashNodeCapability,
  hashNodeDispatch,
  hashNodeJobResult
} from "@/lib/nodes/hashes";
import type { HardwareInventory, NodeCapability } from "@/lib/nodes/contracts";
import type {
  NodeJobDispatch,
  NodeJobResultSubmission
} from "@/lib/nodes/dispatch-contracts";

const hash64 = "b".repeat(64);

function inventory(): Omit<HardwareInventory, "inventoryHash"> {
  return {
    nodeId: "node-1",
    platform: "linux",
    architecture: "arm64",
    cpu: {
      architecture: "arm64",
      model: "ARM CPU",
      sockets: 1,
      physicalCores: 4,
      logicalThreads: 4,
      virtualizationSupported: true
    },
    memory: { totalBytes: 8_000_000_000 },
    gpus: [],
    storage: [],
    network: [],
    operatingSystem: {
      distribution: "Debian",
      version: "13",
      kernel: "6.x"
    },
    cgroups: {
      version: 2,
      available: true
    },
    discoveredAt: "2026-09-21T12:00:00Z"
  };
}

describe("Phase 28 canonical hashes", () => {
  it("hashes hardware inventory deterministically", () => {
    const left = inventory();
    const right = {
      ...left,
      operatingSystem: {
        kernel: left.operatingSystem.kernel,
        version: left.operatingSystem.version,
        distribution: left.operatingSystem.distribution
      }
    };
    expect(hashHardwareInventory(left)).toBe(hashHardwareInventory(right));
    expect(hashHardwareInventory(left)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("serializes capability constraint keys idempotently", () => {
    const first: Omit<NodeCapability, "capabilityHash"> = {
      id: "capability-1",
      nodeId: "node-1",
      name: "container.run",
      status: "validated",
      evidenceIds: ["evidence-1"],
      constraints: { memory: 2, cpu: 1 },
      observedAt: "2026-09-21T12:00:00Z"
    };
    const second = {
      ...first,
      constraints: { cpu: 1, memory: 2 }
    };
    expect(hashNodeCapability(first)).toBe(hashNodeCapability(second));
  });

  it("detects dispatch tampering", () => {
    const base: Omit<NodeJobDispatch, "payloadHash"> = {
      id: "dispatch-1",
      nodeId: "node-1",
      jobId: "job-1",
      reservationId: "reservation-1",
      authorizationConsumptionHash: hash64,
      executionSpecHash: hash64,
      architecture: "x86_64",
      capability: "container.run",
      resourceLimits: {
        cpuMillicores: 1000,
        memoryBytes: 2048
      },
      createdAt: "2026-09-21T12:00:00Z",
      expiresAt: "2026-09-21T12:05:00Z"
    };
    const dispatch: NodeJobDispatch = {
      ...base,
      payloadHash: hashNodeDispatch(base)
    };
    expect(assertNodeDispatchIntegrity(dispatch)).toEqual(dispatch);
    expect(() => assertNodeDispatchIntegrity({
      ...dispatch,
      resourceLimits: { ...dispatch.resourceLimits, cpuMillicores: 2000 }
    })).toThrow(/payload hash/i);
  });

  it("hashes Job results independently of the stored payload hash", () => {
    const result: Omit<NodeJobResultSubmission, "payloadHash"> = {
      id: "result-1",
      nodeId: "node-1",
      jobId: "job-1",
      reservationId: "reservation-1",
      authorizationConsumptionHash: hash64,
      executionSpecHash: hash64,
      createdAt: "2026-09-21T12:00:00Z",
      expiresAt: "2026-09-21T12:10:00Z",
      observedAt: "2026-09-21T12:01:00Z",
      exitCode: 0,
      artifactReferences: [],
      durationMs: 1000
    };
    expect(hashNodeJobResult(result)).toMatch(/^[a-f0-9]{64}$/);
  });
});
