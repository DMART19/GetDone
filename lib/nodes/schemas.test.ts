import { describe, expect, it } from "vitest";
import { hashNodeDispatch, hashNodeJobResult } from "@/lib/nodes/hashes";
import {
  hardwareInventorySchema,
  nodeArchitectureSchema,
  nodeEnrollmentSchema,
  nodeReservationAcknowledgementSchema,
  parseNodeJobDispatch,
  parseNodeJobResult
} from "@/lib/nodes/schemas";

function dispatchBase() {
  return {
    id: "dispatch-1",
    nodeId: "node-1",
    jobId: "job-1",
    reservationId: "reservation-1",
    authorizationConsumptionHash: "a".repeat(64),
    executionSpecHash: "b".repeat(64),
    createdAt: "2026-09-21T10:00:00Z",
    expiresAt: "2026-09-21T10:10:00Z",
    architecture: "arm64" as const,
    capability: "container.run",
    resourceLimits: {
      cpuMillicores: 1000,
      memoryBytes: 512_000_000
    },
    workloadReference: "image@sha256:abc",
    timeoutSeconds: 300
  };
}

describe("Phase 28 node protocol schemas", () => {
  it("accepts Linux x86-64 and ARM64 and rejects unsupported authoritative architectures", () => {
    expect(nodeArchitectureSchema.parse("x86_64")).toBe("x86_64");
    expect(nodeArchitectureSchema.parse("arm64")).toBe("arm64");
    expect(() => nodeArchitectureSchema.parse("riscv64")).toThrow();
  });

  it("requires node enrollment to stay Linux and use supported architecture", () => {
    const base = {
      id: "enrollment-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "development",
      platform: "linux",
      architecture: "arm64",
      ownerActionRequired: false,
      challengeToken: "0123456789abcdef",
      challengeExpiresAt: "2026-09-21T11:00:00Z"
    };
    expect(nodeEnrollmentSchema.parse(base).architecture).toBe("arm64");
    expect(() => nodeEnrollmentSchema.parse({ ...base, architecture: "mips" })).toThrow();
  });

  it("rejects mismatched CPU/inventory architecture", () => {
    const inventory = {
      nodeId: "node-1",
      platform: "linux",
      architecture: "arm64",
      cpu: {
        architecture: "x86_64",
        model: "bad-mismatch",
        sockets: 1,
        physicalCores: 4,
        logicalThreads: 4,
        virtualizationSupported: true
      },
      memory: { totalBytes: 8_000_000_000 },
      gpus: [],
      storage: [],
      network: [],
      operatingSystem: { distribution: "Ubuntu", version: "24.04", kernel: "6.8" },
      cgroups: { version: 2, available: true },
      discoveredAt: "2026-09-21T10:00:00Z",
      inventoryHash: "c".repeat(64)
    };
    expect(() => hardwareInventorySchema.parse(inventory)).toThrow(/architecture/i);
  });

  it("rejects empty reservation lineage before a dispatch can become authoritative", () => {
    expect(() => nodeReservationAcknowledgementSchema.parse({
      id: "ack-1",
      nodeId: "node-1",
      jobId: "job-1",
      reservationId: "",
      authorizationConsumptionHash: "a".repeat(64),
      executionSpecHash: "b".repeat(64),
      createdAt: "2026-09-21T10:00:00Z",
      expiresAt: "2026-09-21T10:10:00Z",
      payloadHash: "c".repeat(64),
      accepted: true,
      observedAt: "2026-09-21T10:00:01Z"
    })).toThrow();
  });

  it("accepts a hash-bound dispatch and rejects tampering", () => {
    const base = dispatchBase();
    const dispatch = { ...base, payloadHash: hashNodeDispatch(base) };
    expect(parseNodeJobDispatch(dispatch, Date.parse("2026-09-21T10:01:00Z")).jobId)
      .toBe("job-1");
    expect(() => parseNodeJobDispatch(
      { ...dispatch, capability: "host.shell.root" },
      Date.parse("2026-09-21T10:01:00Z")
    )).toThrow(/hash/i);
  });

  it("rejects expired dispatches", () => {
    const base = dispatchBase();
    const dispatch = { ...base, payloadHash: hashNodeDispatch(base) };
    expect(() => parseNodeJobDispatch(
      dispatch,
      Date.parse("2026-09-21T10:10:01Z")
    )).toThrow(/expired/i);
  });

  it("accepts hash-bound Job results and rejects tampering", () => {
    const base = {
      id: "result-1",
      nodeId: "node-1",
      jobId: "job-1",
      reservationId: "reservation-1",
      authorizationConsumptionHash: "a".repeat(64),
      executionSpecHash: "b".repeat(64),
      createdAt: "2026-09-21T10:02:00Z",
      expiresAt: "2026-09-21T10:20:00Z",
      dispatchId: "dispatch-1",
      localExecutionId: "local-1",
      exitCode: 0,
      outcome: "completed" as const,
      artifactReferences: [],
      resourceUsage: { cpuPercent: 20, memoryBytes: 128_000_000 },
      observedAt: "2026-09-21T10:03:00Z"
    };
    const result = { ...base, payloadHash: hashNodeJobResult(base) };
    expect(parseNodeJobResult(result, Date.parse("2026-09-21T10:04:00Z")).outcome)
      .toBe("completed");
    expect(() => parseNodeJobResult(
      { ...result, outcome: "failed" },
      Date.parse("2026-09-21T10:04:00Z")
    )).toThrow(/hash/i);
  });
});
