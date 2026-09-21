import { describe, expect, it } from "vitest";
import {
  hashAllocatableProfile,
  hashHardwareInventory,
  hashNodeCapability,
  hashNodeDispatch,
  hashNodeHeartbeat,
  hashNodeJobResult
} from "@/lib/nodes/hashes";

describe("Phase 28 node canonical hashes", () => {
  it("hashes inventory deterministically independent of object key order and existing hash", () => {
    const inventory = {
      nodeId: "node-1",
      platform: "linux" as const,
      architecture: "x86_64" as const,
      cpu: {
        architecture: "x86_64" as const,
        vendor: "vendor",
        model: "model",
        sockets: 1,
        physicalCores: 8,
        logicalThreads: 16,
        virtualizationSupported: true
      },
      memory: { totalBytes: 32_000_000_000 },
      gpus: [],
      storage: [],
      network: [],
      operatingSystem: { distribution: "Ubuntu", version: "24.04", kernel: "6.8" },
      cgroups: { version: 2 as const, available: true },
      discoveredAt: "2026-09-21T10:00:00Z"
    };
    const first = hashHardwareInventory(inventory);
    const second = hashHardwareInventory({ ...inventory, inventoryHash: "f".repeat(64) });
    expect(first).toHaveLength(64);
    expect(second).toBe(first);
  });

  it("binds capability, allocatable, heartbeat, dispatch, and result payloads", () => {
    const capability = {
      id: "cap-1",
      nodeId: "node-1",
      name: "container.run",
      status: "validated" as const,
      evidenceIds: ["evidence-1"],
      constraints: {},
      observedAt: "2026-09-21T10:00:00Z"
    };
    const allocatable = {
      nodeId: "node-1",
      cpuMillicores: 4000,
      memoryBytes: 8_000_000_000,
      ephemeralStorageBytes: 100_000_000_000,
      gpuAllocations: [],
      maxConcurrentJobs: 2,
      executionClasses: ["container-job"],
      allowedDataClasses: ["public" as const],
      resourceLimits: {},
      updatedAt: "2026-09-21T10:00:00Z"
    };
    const heartbeat = {
      nodeId: "node-1",
      sequence: 1,
      agentVersion: "0.0.0",
      protocolVersion: "1.0.0",
      timestamp: "2026-09-21T10:00:00Z",
      health: "healthy" as const,
      runningJobs: 0,
      reserved: { cpuMillicores: 0, memoryBytes: 0, storageBytes: 0 },
      available: { cpuMillicores: 4000, memoryBytes: 8_000_000_000, storageBytes: 100_000_000_000 },
      load: { cpuPercent: 5, memoryPercent: 10 }
    };
    const dispatch = {
      id: "dispatch-1",
      nodeId: "node-1",
      jobId: "job-1",
      reservationId: "reservation-1",
      authorizationConsumptionHash: "a".repeat(64),
      executionSpecHash: "b".repeat(64),
      createdAt: "2026-09-21T10:00:00Z",
      expiresAt: "2026-09-21T10:10:00Z",
      architecture: "x86_64" as const,
      capability: "container.run",
      resourceLimits: { cpuMillicores: 1000, memoryBytes: 512_000_000 },
      workloadReference: "image@sha256:abc",
      timeoutSeconds: 300
    };
    const result = {
      id: "result-1",
      nodeId: "node-1",
      jobId: "job-1",
      reservationId: "reservation-1",
      authorizationConsumptionHash: "a".repeat(64),
      executionSpecHash: "b".repeat(64),
      createdAt: "2026-09-21T10:01:00Z",
      expiresAt: "2026-09-21T10:20:00Z",
      dispatchId: "dispatch-1",
      localExecutionId: "local-1",
      exitCode: 0,
      outcome: "completed" as const,
      artifactReferences: [],
      resourceUsage: { cpuPercent: 20, memoryBytes: 128_000_000 },
      observedAt: "2026-09-21T10:02:00Z"
    };

    for (const value of [
      hashNodeCapability(capability),
      hashAllocatableProfile(allocatable),
      hashNodeHeartbeat(heartbeat),
      hashNodeDispatch(dispatch),
      hashNodeJobResult(result)
    ]) {
      expect(value).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
