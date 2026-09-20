import { describe, expect, it } from "vitest";
import {
  createCapabilityValidationEvidence,
  simulateResourceTelemetry,
  summarizeResourceHealth,
  validateResourceProfile
} from "@/lib/resources/profiling";

const now = Date.parse("2026-09-20T22:00:00Z");

const claim = {
  resourceId: "pi-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  architecture: "arm64",
  cpuCores: 4,
  memoryMb: 8192,
  gpu: { model: "imaginary-h100", count: 1, vramMb: 81920 },
  diskGb: 256,
  networkMbps: 1000,
  runtimeNames: ["node"],
  supportedSoftware: ["worker"],
  claimedCapabilities: ["compute.cpu", "gpu.inference"],
  observedAt: "2026-09-20T21:59:00Z",
  source: "resource-agent" as const
};

describe("Phase 30 resource profiling and simulator", () => {
  it("keeps ordinary claims while rejecting fabricated privileged GPU claims", () => {
    const profile = validateResourceProfile({
      id: "profile-1",
      claim,
      evidence: [],
      expiresAt: "2026-09-20T22:05:00Z",
      now
    });

    expect(profile.validatedCapabilities).toContain("compute.cpu");
    expect(profile.validatedCapabilities).not.toContain("gpu.inference");
    expect(profile.gpu).toBeUndefined();
    expect(profile.rejectedClaims.map((item) => item.claim)).toContain("gpu.hardware");
  });

  it("accepts a privileged GPU only with independent valid evidence", () => {
    const evidence = [
      createCapabilityValidationEvidence({
        id: "gpu-hardware-proof",
        resourceId: "pi-1",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        capability: "gpu.hardware",
        validator: "hardware-attestation",
        validated: true,
        observedAt: "2026-09-20T21:58:00Z",
        expiresAt: "2026-09-20T22:10:00Z"
      }),
      createCapabilityValidationEvidence({
        id: "gpu-inference-proof",
        resourceId: "pi-1",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        capability: "gpu.inference",
        validator: "control-plane-probe",
        validated: true,
        observedAt: "2026-09-20T21:58:00Z",
        expiresAt: "2026-09-20T22:10:00Z"
      })
    ];

    const profile = validateResourceProfile({
      id: "profile-2",
      claim,
      evidence,
      expiresAt: "2026-09-20T22:05:00Z",
      now
    });

    expect(profile.gpu?.vramMb).toBe(81920);
    expect(profile.validatedCapabilities).toContain("gpu.inference");
  });

  it("maps stale telemetry to unreachable", () => {
    const simulation = simulateResourceTelemetry({
      scenario: "stale",
      resourceId: "pi-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      at: "2026-09-20T22:00:00Z"
    });

    const health = summarizeResourceHealth({
      resourceId: "pi-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      samples: simulation.samples,
      now,
      staleAfterSeconds: 120
    });

    expect(health.status).toBe("unreachable");
    expect(simulation.sideEffects).toEqual([]);
  });

  it("maps deterministic simulator scenarios to health without side effects", () => {
    const degraded = simulateResourceTelemetry({
      scenario: "degraded",
      resourceId: "pi-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      at: "2026-09-20T22:00:00Z"
    });
    const saturated = simulateResourceTelemetry({
      scenario: "saturated",
      resourceId: "pi-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      at: "2026-09-20T22:00:00Z"
    });

    expect(summarizeResourceHealth({
      resourceId: "pi-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      samples: degraded.samples,
      now
    }).status).toBe("degraded");

    expect(summarizeResourceHealth({
      resourceId: "pi-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      samples: saturated.samples,
      now
    }).status).toBe("saturated");

    expect(degraded.sideEffects).toEqual([]);
    expect(saturated.sideEffects).toEqual([]);
  });

  it("rejects unauthenticated telemetry as health authority", () => {
    expect(() => summarizeResourceHealth({
      resourceId: "pi-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      samples: [{
        id: "forged",
        resourceId: "pi-1",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        authenticated: false,
        observedAt: "2026-09-20T21:59:30Z",
        cpuUtilizationPct: 1,
        memoryUtilizationPct: 1,
        diskUtilizationPct: 1,
        heartbeatOk: true
      }],
      now
    })).toThrow();
  });
});
