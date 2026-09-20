import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditLedger } from "@/lib/domain/audit";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import { MemoryIdempotencyStore } from "@/lib/domain/idempotency";
import {
  ResourceEnrollmentService,
  assertEnrollmentChallenge,
  type ResourceEnrollmentRecord,
  type ResourceEnrollmentStores
} from "@/lib/resources/enrollment";

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
  async append(event: AuditEvent) { this.events.push(event); }
  async listByCorrelationId(correlationId: string) {
    return this.events.filter((event) => event.correlationId === correlationId);
  }
}

function manager(
  store: MemoryEnrollmentStore,
  registryReady = true
): ControlPlaneTransactionManager<ResourceEnrollmentStores> {
  const audit = new MemoryAudit();
  const idempotency = new MemoryIdempotencyStore();
  return {
    run: async (operation) => operation({
      stores: {
        enrollments: store,
        resourceReadiness: {
          get: async (resourceId: string) => ({
            resourceId,
            portfolioId: "portfolio-a",
            companyId: "company-a",
            ready: registryReady,
            evidenceId: "resource-readiness-evidence"
          })
        }
      },
      audit,
      idempotency
    })
  };
}

let counter = 0;
function command(type: string) {
  counter += 1;
  return createCommandEnvelope({
    commandId: "enrollment-command-" + counter,
    actor: { type: "user", id: "user-a" },
    scope: {
      userId: "user-a",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "development"
    },
    correlationId: "enrollment-correlation-" + counter,
    environment: "development",
    idempotencyKey: "enrollment-idempotency-" + counter,
    provenance: "unit-test",
    requestedMutation: { type }
  });
}

describe("resource enrollment workflow", () => {
  it("runs the deterministic enrollment sequence and consumes the challenge once", async () => {
    const store = new MemoryEnrollmentStore();
    const service = new ResourceEnrollmentService(manager(store));

    await service.identify({
      id: "enrollment-1",
      requestedType: "compute",
      requestedEnvironments: ["development"],
      ownerActionRequired: true,
      ownerActionDescription: "Install the GetDone agent",
      challengeToken: "one-time-secret",
      challengeIssuedAt: "2026-09-20T20:00:00Z",
      challengeExpiresAt: "2026-09-20T20:30:00Z"
    }, command("identify"));

    await service.createEnrollment("enrollment-1", command("create"));
    await expect(
      service.authenticate(
        "enrollment-1",
        command("authenticate-too-early"),
        "one-time-secret",
        "auth-evidence",
        "2026-09-20T20:05:00Z"
      )
    ).rejects.toThrow();

    await service.recordOwnerAction("enrollment-1", command("owner-action"), "owner-evidence");
    await service.authenticate(
      "enrollment-1",
      command("authenticate"),
      "one-time-secret",
      "auth-evidence",
      "2026-09-20T20:05:00Z"
    );
    await service.discover("enrollment-1", command("discover"), "discover-evidence");
    await service.profile("enrollment-1", command("profile"), "profile-evidence");
    await service.validate("enrollment-1", command("validate"), "validate-evidence");
    await service.test("enrollment-1", command("test"), "test-evidence");
    await service.register(
      "enrollment-1",
      command("register"),
      "resource-1",
      "registry-evidence"
    );
    const ready = await service.markReady(
      "enrollment-1",
      command("ready")
    );

    expect(ready.state).toBe("ready");
    expect(ready.resourceId).toBe("resource-1");
    expect(ready.challengeConsumedAt).toBe("2026-09-20T20:05:00Z");
    expect(() => assertEnrollmentChallenge(
      ready,
      "one-time-secret",
      Date.parse("2026-09-20T20:06:00Z")
    )).toThrow();
  });

  it("does not let enrollment become READY before the Resource Registry is ready", async () => {
    const store = new MemoryEnrollmentStore();
    const service = new ResourceEnrollmentService(manager(store, false));

    await service.identify({
      id: "enrollment-registry-gate",
      requestedType: "compute",
      requestedEnvironments: ["development"],
      ownerActionRequired: false,
      challengeToken: "registry-secret",
      challengeIssuedAt: "2026-09-20T20:00:00Z",
      challengeExpiresAt: "2026-09-20T21:00:00Z"
    }, command("identify-registry-gate"));
    await service.createEnrollment("enrollment-registry-gate", command("create-registry-gate"));
    await service.authenticate(
      "enrollment-registry-gate",
      command("authenticate-registry-gate"),
      "registry-secret",
      "auth-evidence",
      "2026-09-20T20:05:00Z"
    );
    await service.discover("enrollment-registry-gate", command("discover-registry-gate"), "discover-evidence");
    await service.profile("enrollment-registry-gate", command("profile-registry-gate"), "profile-evidence");
    await service.validate("enrollment-registry-gate", command("validate-registry-gate"), "validate-evidence");
    await service.test("enrollment-registry-gate", command("test-registry-gate"), "test-evidence");
    await service.register(
      "enrollment-registry-gate",
      command("register-registry-gate"),
      "resource-gated",
      "registry-evidence"
    );

    await expect(
      service.markReady("enrollment-registry-gate", command("ready-registry-gate"))
    ).rejects.toThrow();
  });

  it("rejects expired challenges and supports deterministic restart", async () => {
    const store = new MemoryEnrollmentStore();
    const service = new ResourceEnrollmentService(manager(store));

    await service.identify({
      id: "enrollment-2",
      requestedType: "compute",
      requestedEnvironments: ["development"],
      ownerActionRequired: false,
      challengeToken: "old-secret",
      challengeIssuedAt: "2026-09-20T20:00:00Z",
      challengeExpiresAt: "2026-09-20T20:01:00Z"
    }, command("identify-expiring"));
    await service.createEnrollment("enrollment-2", command("create-expiring"));

    await expect(service.authenticate(
      "enrollment-2",
      command("expired-auth"),
      "old-secret",
      "auth-evidence",
      "2026-09-20T20:02:00Z"
    )).rejects.toThrow();

    await service.expire("enrollment-2", command("expire"));
    const restarted = await service.restart(
      "enrollment-2",
      command("restart"),
      "new-secret",
      "2026-09-20T21:00:00Z",
      "2026-09-20T20:03:00Z"
    );

    expect(restarted.state).toBe("identify");
    expect(restarted.attempt).toBe(2);
    expect(() => assertEnrollmentChallenge(
      restarted,
      "old-secret",
      Date.parse("2026-09-20T20:04:00Z")
    )).toThrow();
    expect(() => assertEnrollmentChallenge(
      restarted,
      "new-secret",
      Date.parse("2026-09-20T20:04:00Z")
    )).not.toThrow();
  });
});
