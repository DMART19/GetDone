import { describe, expect, it, vi } from "vitest";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import {
  NodeEnrollmentCoordinator,
  type NodeEnrollmentDelegate,
  type NodeEnrollmentIdentityEvidence,
  type NodeEnrollmentProfile,
  type NodeEnrollmentRequest
} from "@/lib/nodes/enrollment";
import type { ResourceEnrollmentRecord } from "@/lib/resources/enrollment";

function command(environment: "development" | "staging" | "production" = "development") {
  return createCommandEnvelope({
    commandId: "node-enrollment-command",
    actor: { type: "user", id: "owner-a" },
    scope: {
      userId: "owner-a",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment
    },
    correlationId: "node-enrollment-correlation",
    environment,
    idempotencyKey: "node-enrollment-idempotency",
    provenance: "phase28-test",
    requestedMutation: { type: "node.enroll" }
  });
}

const record: ResourceEnrollmentRecord = {
  id: "enrollment-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  state: "identify",
  requestedType: "compute",
  requestedEnvironments: ["development"],
  ownerActionRequired: false,
  challengeHash: "challenge-hash",
  challengeIssuedAt: "2026-09-21T10:00:00Z",
  challengeExpiresAt: "2026-09-21T11:00:00Z",
  evidenceIds: [],
  attempt: 1,
  version: 1,
  updatedAt: "2026-09-21T10:00:00Z"
};

function delegate() {
  const resolved = () => Promise.resolve(record);
  return {
    identify: vi.fn(resolved),
    createEnrollment: vi.fn(resolved),
    authenticate: vi.fn(resolved),
    discover: vi.fn(resolved),
    profile: vi.fn(resolved),
    validate: vi.fn(resolved),
    test: vi.fn(resolved),
    register: vi.fn(resolved),
    markReady: vi.fn(resolved)
  } satisfies NodeEnrollmentDelegate;
}

function request(
  architecture: "x86_64" | "arm64" = "x86_64"
): NodeEnrollmentRequest {
  return {
    id: "enrollment-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "development",
    platform: "linux",
    architecture,
    ownerActionRequired: false,
    challengeToken: "0123456789abcdef",
    challengeIssuedAt: "2026-09-21T10:00:00Z",
    challengeExpiresAt: "2026-09-21T11:00:00Z"
  };
}

describe("Phase 28 NodeEnrollmentCoordinator", () => {
  it("delegates x86-64 and ARM64 identification into authoritative Resource Enrollment as compute", async () => {
    for (const architecture of ["x86_64", "arm64"] as const) {
      const service = delegate();
      const coordinator = new NodeEnrollmentCoordinator(service);
      await coordinator.identify(request(architecture), command());

      expect(service.identify).toHaveBeenCalledTimes(1);
      expect(service.identify).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "enrollment-1",
          requestedType: "compute",
          requestedEnvironments: ["development"],
          challengeToken: "0123456789abcdef"
        }),
        expect.any(Object)
      );
    }
  });

  it("rejects request scope that differs from trusted command scope before delegation", async () => {
    const service = delegate();
    const coordinator = new NodeEnrollmentCoordinator(service);

    expect(() => coordinator.identify(
      { ...request(), companyId: "company-attacker" },
      command()
    )).toThrow(/trusted command scope/i);

    expect(service.identify).not.toHaveBeenCalled();
  });

  it("binds identity evidence to enrollment and trusted scope before Resource Enrollment authentication", async () => {
    const service = delegate();
    const coordinator = new NodeEnrollmentCoordinator(service);
    const evidence: NodeEnrollmentIdentityEvidence = {
      evidenceId: "identity-evidence-1",
      enrollmentId: "enrollment-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "development",
      platform: "linux",
      architecture: "arm64",
      observedAt: "2026-09-21T10:05:00Z"
    };

    await coordinator.authenticate(
      "enrollment-1",
      command(),
      "0123456789abcdef",
      evidence
    );

    expect(service.authenticate).toHaveBeenCalledWith(
      "enrollment-1",
      expect.any(Object),
      "0123456789abcdef",
      "identity-evidence-1",
      "2026-09-21T10:05:00Z"
    );

    expect(() => coordinator.authenticate(
      "another-enrollment",
      command(),
      "0123456789abcdef",
      evidence
    )).toThrow(/not bound/i);
  });

  it("requires node profile evidence and delegates only its authoritative evidence ID", async () => {
    const service = delegate();
    const coordinator = new NodeEnrollmentCoordinator(service);
    const profile: NodeEnrollmentProfile = {
      evidenceId: "profile-evidence-1",
      enrollmentId: "enrollment-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "development",
      platform: "linux",
      architecture: "x86_64",
      inventoryHash: "a".repeat(64),
      capabilityEvidenceIds: ["capability-evidence-1"],
      observedAt: "2026-09-21T10:06:00Z"
    };

    await coordinator.profile("enrollment-1", command(), profile);
    expect(service.profile).toHaveBeenCalledWith(
      "enrollment-1",
      expect.any(Object),
      "profile-evidence-1"
    );

    expect(() => coordinator.profile(
      "enrollment-1",
      command(),
      { ...profile, inventoryHash: "" }
    )).toThrow(/incomplete/i);
  });

  it("passes later state transitions through the existing Resource Enrollment authority", async () => {
    const service = delegate();
    const coordinator = new NodeEnrollmentCoordinator(service);
    const cmd = command();

    await coordinator.createEnrollment("enrollment-1", cmd);
    await coordinator.discover("enrollment-1", cmd, "discover-evidence");
    await coordinator.validate("enrollment-1", cmd, "validate-evidence");
    await coordinator.test("enrollment-1", cmd, "test-evidence");
    await coordinator.register("enrollment-1", cmd, "resource-1", "register-evidence");
    await coordinator.markReady("enrollment-1", cmd);

    expect(service.createEnrollment).toHaveBeenCalledOnce();
    expect(service.discover).toHaveBeenCalledOnce();
    expect(service.validate).toHaveBeenCalledOnce();
    expect(service.test).toHaveBeenCalledOnce();
    expect(service.register).toHaveBeenCalledOnce();
    expect(service.markReady).toHaveBeenCalledOnce();
  });
});
