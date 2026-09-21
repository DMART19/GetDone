import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditLedger } from "@/lib/domain/audit";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import { MemoryIdempotencyStore } from "@/lib/domain/idempotency";
import {
  ResourceEnrollmentService,
  type ResourceEnrollmentRecord,
  type ResourceEnrollmentStores
} from "@/lib/resources/enrollment";
import {
  NodeEnrollmentCoordinator,
  type NodeEnrollmentIdentityEvidence
} from "@/lib/nodes/enrollment";

class MemoryEnrollmentStore {
  value: ResourceEnrollmentRecord | null = null;

  async create(record: ResourceEnrollmentRecord) {
    if (this.value) throw new Error("already exists");
    this.value = { ...record };
  }

  async get(id: string) {
    return this.value?.id === id ? { ...this.value } : null;
  }

  async save(next: ResourceEnrollmentRecord, expectedVersion: number) {
    if (!this.value || this.value.version !== expectedVersion) {
      throw new Error("optimistic concurrency conflict");
    }
    this.value = { ...next };
  }
}

class MemoryAudit implements AuditLedger {
  readonly events: AuditEvent[] = [];
  async append(event: AuditEvent) {
    this.events.push(event);
  }
  async listByCorrelationId(correlationId: string) {
    return this.events.filter((event) => event.correlationId === correlationId);
  }
}

function manager(
  store: MemoryEnrollmentStore
): ControlPlaneTransactionManager<ResourceEnrollmentStores> {
  return {
    run: async (operation) => operation({
      stores: {
        enrollments: store,
        resourceReadiness: {
          get: async (resourceId: string) => ({
            resourceId,
            portfolioId: "portfolio-a",
            companyId: "company-a",
            ready: true,
            evidenceId: "resource-ready-evidence"
          })
        }
      },
      audit: new MemoryAudit(),
      idempotency: new MemoryIdempotencyStore()
    })
  };
}

let commandCounter = 0;
function command(type: string) {
  commandCounter += 1;
  return createCommandEnvelope({
    commandId: `node-enrollment-command-${commandCounter}`,
    actor: { type: "user", id: "owner-a" },
    scope: {
      userId: "owner-a",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "development"
    },
    correlationId: `node-enrollment-correlation-${commandCounter}`,
    environment: "development",
    idempotencyKey: `node-enrollment-idempotency-${commandCounter}`,
    provenance: "phase28-unit-test",
    requestedMutation: { type }
  });
}

function request(architecture: "x86_64" | "arm64" = "x86_64") {
  return {
    id: "node-enrollment-1",
    displayName: "General Linux node",
    platform: "linux" as const,
    architecture,
    agentVersion: "0.1.0",
    protocolVersion: "1.0.0",
    requestedEnvironments: ["development"] as const,
    ownerActionRequired: false,
    challengeToken: "node-enrollment-secret",
    challengeIssuedAt: "2026-09-21T12:00:00Z",
    challengeExpiresAt: "2026-09-21T12:30:00Z"
  };
}

function evidence(
  overrides: Partial<NodeEnrollmentIdentityEvidence> = {}
): NodeEnrollmentIdentityEvidence {
  return {
    evidenceId: "node-identity-evidence",
    enrollmentId: "node-enrollment-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    platform: "linux",
    architecture: "x86_64",
    publicKeyFingerprint: "sha256:node-public-key",
    observedAt: "2026-09-21T12:05:00Z",
    ...overrides
  };
}

describe("NodeEnrollmentCoordinator", () => {
  it.each(["x86_64", "arm64"] as const)(
    "delegates %s node identification to Resource Enrollment as compute",
    async (architecture) => {
      const store = new MemoryEnrollmentStore();
      const coordinator = new NodeEnrollmentCoordinator(
        new ResourceEnrollmentService(manager(store))
      );
      const identified = await coordinator.identify(request(architecture), command("identify"));

      expect(identified.requestedType).toBe("compute");
      expect(identified.requestedEnvironments).toEqual(["development"]);
      expect(store.value?.state).toBe("identify");
    }
  );

  it("rejects protocol or environment scope drift before delegation", async () => {
    const coordinator = new NodeEnrollmentCoordinator(
      new ResourceEnrollmentService(manager(new MemoryEnrollmentStore()))
    );

    expect(() => coordinator.identify({
      ...request(),
      protocolVersion: "2.0.0"
    }, command("bad-protocol"))).toThrow(/protocol version/i);

    expect(() => coordinator.identify({
      ...request(),
      requestedEnvironments: ["production"]
    }, command("bad-scope"))).toThrow(/trusted environment scope/i);
  });

  it("rejects identity evidence from another company", async () => {
    const store = new MemoryEnrollmentStore();
    const coordinator = new NodeEnrollmentCoordinator(
      new ResourceEnrollmentService(manager(store))
    );
    await coordinator.identify(request(), command("identify-for-auth"));
    await coordinator.createEnrollment("node-enrollment-1", command("create-for-auth"));

    expect(() => coordinator.authenticate(
      "node-enrollment-1",
      command("authenticate-wrong-company"),
      "node-enrollment-secret",
      evidence({ companyId: "company-b" }),
      "2026-09-21T12:05:00Z"
    )).toThrow(/trusted command scope/i);
  });

  it("passes validated identity and profile evidence through the existing enrollment sequence", async () => {
    const store = new MemoryEnrollmentStore();
    const coordinator = new NodeEnrollmentCoordinator(
      new ResourceEnrollmentService(manager(store))
    );

    await coordinator.identify(request(), command("identify-sequence"));
    await coordinator.createEnrollment("node-enrollment-1", command("create-sequence"));
    await coordinator.authenticate(
      "node-enrollment-1",
      command("authenticate-sequence"),
      "node-enrollment-secret",
      evidence(),
      "2026-09-21T12:05:00Z"
    );
    await coordinator.discover(
      "node-enrollment-1",
      command("discover-sequence"),
      "discover-evidence"
    );
    const profiled = await coordinator.profile(
      "node-enrollment-1",
      command("profile-sequence"),
      {
        evidenceId: "profile-evidence",
        enrollmentId: "node-enrollment-1",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        platform: "linux",
        architecture: "x86_64",
        agentVersion: "0.1.0",
        protocolVersion: "1.0.0",
        observedAt: "2026-09-21T12:06:00Z"
      }
    );

    expect(profiled.state).toBe("profile");
    expect(profiled.evidenceIds).toContain("node-identity-evidence");
    expect(profiled.evidenceIds).toContain("profile-evidence");
  });
});
