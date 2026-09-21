import { describe, expect, it } from "vitest";
import {
  nodeEnrollmentSchema,
  nodeJobDispatchSchema
} from "@/lib/nodes/schemas";

const hash = "a".repeat(64);

function dispatch(overrides: Record<string, unknown> = {}) {
  return {
    id: "dispatch-1",
    nodeId: "node-1",
    jobId: "job-1",
    reservationId: "reservation-1",
    authorizationConsumptionHash: hash,
    executionSpecHash: hash,
    createdAt: "2026-09-21T12:00:00Z",
    expiresAt: "2026-09-21T12:05:00Z",
    payloadHash: hash,
    architecture: "x86_64",
    capability: "container.run",
    resourceLimits: {
      cpuMillicores: 1000,
      memoryBytes: 1024
    },
    ...overrides
  };
}

describe("Phase 28 node protocol schemas", () => {
  it.each(["x86_64", "arm64"])("accepts supported architecture %s", (architecture) => {
    const result = nodeEnrollmentSchema.safeParse({
      id: "enrollment-1",
      displayName: "Linux compute",
      platform: "linux",
      architecture,
      agentVersion: "0.1.0",
      protocolVersion: "1.0.0",
      requestedEnvironments: ["development"],
      ownerActionRequired: false,
      challengeToken: "challenge-token-long-enough",
      challengeExpiresAt: "2026-09-21T12:05:00Z"
    });
    expect(result.success).toBe(true);
  });

  it("rejects unsupported architectures and unknown authoritative fields", () => {
    expect(nodeEnrollmentSchema.safeParse({
      id: "enrollment-1",
      displayName: "Unsupported",
      platform: "linux",
      architecture: "riscv64",
      agentVersion: "0.1.0",
      protocolVersion: "1.0.0",
      requestedEnvironments: ["development"],
      ownerActionRequired: false,
      challengeToken: "challenge-token-long-enough",
      challengeExpiresAt: "2026-09-21T12:05:00Z"
    }).success).toBe(false);

    expect(nodeJobDispatchSchema.safeParse(dispatch({ surpriseAuthority: true })).success)
      .toBe(false);
  });

  it("rejects expired dispatch windows", () => {
    expect(nodeJobDispatchSchema.safeParse(dispatch({
      expiresAt: "2026-09-21T11:59:59Z"
    })).success).toBe(false);
  });

  it("rejects an invalid reservation binding", () => {
    expect(nodeJobDispatchSchema.safeParse(dispatch({
      reservationId: ""
    })).success).toBe(false);
  });
});
