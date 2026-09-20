import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditLedger } from "@/lib/domain/audit";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import { MemoryIdempotencyStore } from "@/lib/domain/idempotency";
import {
  ResourceEnrollmentService,
  type ResourceEnrollmentStores
} from "@/lib/domain/services/resource-enrollment-service";
import type { ResourceEnrollmentRecord } from "@/lib/domain/enrollment";

class EnrollmentStore {
  value: ResourceEnrollmentRecord | null = null;
  async get(id: string) {
    return this.value?.id === id ? { ...this.value } : null;
  }
  async create(record: ResourceEnrollmentRecord) {
    if (this.value) throw new Error("already exists");
    this.value = { ...record };
  }
  async save(next: ResourceEnrollmentRecord, expectedVersion: number) {
    if (!this.value || this.value.version !== expectedVersion) throw new Error("version conflict");
    this.value = { ...next };
  }
}

class Audit implements AuditLedger {
  events: AuditEvent[] = [];
  async append(event: AuditEvent) { this.events.push(event); }
  async listByCorrelationId(id: string) { return this.events.filter((event) => event.correlationId === id); }
}

function manager(store: EnrollmentStore): ControlPlaneTransactionManager<ResourceEnrollmentStores> {
  const audit = new Audit();
  const idempotency = new MemoryIdempotencyStore();
  return {
    run: async (operation) => operation({ stores: { enrollments: store }, audit, idempotency })
  };
}

let counter = 0;
function command(type: string) {
  counter += 1;
  return createCommandEnvelope({
    commandId: `command-${counter}`,
    actor: { type: "user", id: "user-a" },
    scope: {
      userId: "user-a",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "development"
    },
    correlationId: `correlation-${counter}`,
    environment: "development",
    idempotencyKey: `idempotency-${counter}`,
    provenance: "unit-test",
    requestedMutation: { type }
  });
}

const token = "one-time-token-12345";
const challenge = "challenge-value-12345";
const now = Date.parse("2026-09-20T20:00:00Z");

describe("resource enrollment workflow", () => {
  it("executes the deterministic enrollment sequence without persisting raw secrets", async () => {
    const store = new EnrollmentStore();
    const service = new ResourceEnrollmentService(manager(store));

    const identified = await service.identify({
      id: "enrollment-1",
      requestedType: "compute",
      environmentPermissions: ["development"],
      adapterPath: "linux-agent",
      ownerActionRequired: true,
      token,
      challenge,
      expiresAt: "2026-09-20T21:00:00Z",
      identifiedAt: "2026-09-20T19:59:00Z"
    }, command("identify"));

    expect(JSON.stringify(identified)).not.toContain(token);
    expect(JSON.stringify(identified)).not.toContain(challenge);

    await service.createEnrollment("enrollment-1", command("create"), token, now);
    await service.completeOwnerAction("enrollment-1", command("owner"), ["owner-proof"], now);
    await service.authenticate("enrollment-1", command("auth"), challenge, ["auth-proof"], now);
    await service.discover("enrollment-1", command("discover"), ["discover-proof"], now);
    await service.profile("enrollment-1", command("profile"), ["profile-proof"], now);
    await service.validate("enrollment-1", command("validate"), ["validate-proof"], now);
    await service.test("enrollment-1", command("test"), ["test-proof"], now);
    await service.register("enrollment-1", command("register"), ["registry-proof"], now);
    const ready = await service.ready("enrollment-1", command("ready"), ["ready-proof"], now);

    expect(ready.state).toBe("ready");
    expect(ready.tokenConsumedAt).toBeDefined();
    expect(ready.challengeConsumedAt).toBeDefined();
  });

  it("rejects a replayed enrollment token", async () => {
    const store = new EnrollmentStore();
    const service = new ResourceEnrollmentService(manager(store));
    await service.identify({
      id: "enrollment-2",
      requestedType: "compute",
      environmentPermissions: ["development"],
      adapterPath: "linux-agent",
      ownerActionRequired: false,
      token,
      challenge,
      expiresAt: "2026-09-20T21:00:00Z",
      identifiedAt: "2026-09-20T19:59:00Z"
    }, command("identify-2"));

    await service.createEnrollment("enrollment-2", command("create-2"), token, now);
    await expect(
      service.createEnrollment("enrollment-2", command("replay"), token, now)
    ).rejects.toThrow();
  });

  it("fails closed after expiry", async () => {
    const store = new EnrollmentStore();
    const service = new ResourceEnrollmentService(manager(store));
    await service.identify({
      id: "enrollment-3",
      requestedType: "compute",
      environmentPermissions: ["development"],
      adapterPath: "linux-agent",
      ownerActionRequired: false,
      token,
      challenge,
      expiresAt: "2026-09-20T20:01:00Z",
      identifiedAt: "2026-09-20T19:59:00Z"
    }, command("identify-3"));

    await expect(
      service.createEnrollment(
        "enrollment-3",
        command("expired-create"),
        token,
        Date.parse("2026-09-20T20:02:00Z")
      )
    ).rejects.toThrow();
  });

  it("restarts cancelled enrollment with new one-time material and increments attempt", async () => {
    const store = new EnrollmentStore();
    const service = new ResourceEnrollmentService(manager(store));
    await service.identify({
      id: "enrollment-4",
      requestedType: "compute",
      environmentPermissions: ["development"],
      adapterPath: "linux-agent",
      ownerActionRequired: false,
      token,
      challenge,
      expiresAt: "2026-09-20T21:00:00Z",
      identifiedAt: "2026-09-20T19:59:00Z"
    }, command("identify-4"));

    await service.cancel("enrollment-4", command("cancel"));
    const restarted = await service.restart("enrollment-4", command("restart"), {
      token: "replacement-token-12345",
      challenge: "replacement-challenge-12345",
      expiresAt: "2026-09-20T22:00:00Z"
    }, now);

    expect(restarted.state).toBe("identify");
    expect(restarted.attempt).toBe(2);
    expect(restarted.tokenConsumedAt).toBeUndefined();
    expect(restarted.challengeConsumedAt).toBeUndefined();
  });
});
