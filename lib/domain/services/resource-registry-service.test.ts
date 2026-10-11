import { describe, expect, it, vi } from "vitest";
import { createCommandEnvelope, commandFingerprint } from "@/lib/control-plane/command-envelope";
import { MemoryIdempotencyStore } from "@/lib/domain/idempotency";
import type { Resource, ResourceScopedEvidence } from "@/lib/domain/resources";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import { ResourceRegistryService, type ResourceRegistryStores, type DiscoverResourceInput } from "./resource-registry-service";
const timestamp = "2026-10-10T12:00:00.000Z";
const scope = { userId: "owner-a", portfolioId: "portfolio-a", companyId: "company-a", environment: "staging" as const };
function command(id: string) {
  return createCommandEnvelope({ commandId: id, actor: { type: "user", id: scope.userId }, scope, correlationId: id, environment: scope.environment, idempotencyKey: id, provenance: "test:resource-registry", requestedMutation: { operation: id } });
}
function evidenceStore<T extends ResourceScopedEvidence>() {
  const records: T[] = [];
  return { append: vi.fn(async (record: T) => { records.push(record); }), listByResourceId: async (id: string) => records.filter(r => r.resourceId === id) };
}
function fixture() {
  const resources = new Map<string, Resource>();
  const stores: ResourceRegistryStores = { resources: {
    get: async id => resources.get(id) ?? null, create: async resource => { resources.set(resource.id, resource); }, listByScope: async (portfolio, company) => [...resources.values()].filter(r => r.portfolioId === portfolio && r.companyId === company),
    save: async (next, version) => { expect(resources.get(next.id)?.version).toBe(version); resources.set(next.id, next); }
  }, identities: evidenceStore(), trust: evidenceStore(), health: evidenceStore(), capabilities: evidenceStore(), locations: evidenceStore(), costs: evidenceStore(), providers: evidenceStore() };
  const audit = { append: vi.fn(async () => {}), listByCorrelationId: async () => [] };
  const idempotency = new MemoryIdempotencyStore();
  const manager: ControlPlaneTransactionManager<ResourceRegistryStores> = { run: operation => operation({ stores, audit, idempotency }) };
  const service = new ResourceRegistryService(manager);
  const input: DiscoverResourceInput = { id: "node-1", type: "compute", environmentPermissions: ["staging"], discoveredAt: timestamp };
  return { service, stores, resources, audit, idempotency, input };
}
describe("resource registry authority", () => {
  it("discovers immutable, public-only resources and replays without duplicate audit", async () => {
    const f = fixture(); const cmd = command("discover");
    const result = await f.service.discover(f.input, cmd);
    expect(result).toMatchObject({ state: "discovered", trustClass: "untrusted", dataClassesAllowed: ["public"], portfolioId: scope.portfolioId, companyId: scope.companyId, version: 1 });
    expect(Object.isFrozen(result.capabilityNames)).toBe(true);
    expect(await f.service.discover(f.input, cmd)).toEqual(result);
    expect(f.audit.append).toHaveBeenCalledOnce();
  });
  it.each([[], ["production"], ["staging", "production"]] as const)("rejects discovery environment expansion %j", async (...environments) => {
    const f = fixture();
    await expect(f.service.discover({ ...f.input, environmentPermissions: environments.flat() }, command("discover"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.resources.size).toBe(0);
  });
  it.each([[], ["internal"], ["public", "customer"]] as const)("rejects discovery data access expansion %j", async (...classes) => {
    const f = fixture();
    await expect(f.service.discover({ ...f.input, dataClassesAllowed: classes.flat() }, command("discover"))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it.each(["IN_PROGRESS", "FAILED"] as const)("refuses discovery already %s", async state => {
    const f = fixture(); const cmd = command("discover"); const hash = commandFingerprint(cmd);
    await f.idempotency.claim(cmd.idempotencyKey, hash, timestamp);
    if (state === "FAILED") await f.idempotency.fail(cmd.idempotencyKey, hash, "ERROR", timestamp);
    await expect(f.service.discover(f.input, cmd)).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("enrolls, profiles and validates only after scoped evidence, then records health transitions", async () => {
    const f = fixture();
    await f.service.discover({ ...f.input, trustClass: "restricted", capabilityNames: ["compute.cpu.light"], policyBindingIds: ["policy-1"], credentialBindingIds: ["binding-1"], failureDomainIds: ["zone-1"] }, command("discover"));
    expect((await f.service.beginEnrollment(f.input.id, command("enroll"))).state).toBe("enrolling");
    expect((await f.service.beginProfiling(f.input.id, command("profile"))).state).toBe("profiling");
    expect((await f.service.beginValidation(f.input.id, command("validate"))).state).toBe("validating");
    await expect(f.service.markReady(f.input.id, command("ready-without-evidence"), timestamp)).rejects.toThrow("cannot become READY");
    const base = { resourceId: f.input.id, portfolioId: scope.portfolioId, companyId: scope.companyId, observedAt: timestamp };
    const identity = { ...base, id: "identity-1", identityType: "agent-key" as const, subject: "node", verifier: "getdone", verified: true };
    const evidenceCommand = command("identity");
    expect(await f.service.addIdentityEvidence(f.input.id, identity, evidenceCommand)).toEqual(identity);
    expect(await f.service.addIdentityEvidence(f.input.id, identity, evidenceCommand)).toEqual(identity);
    expect(await f.stores.identities.listByResourceId(f.input.id)).toHaveLength(1);
    await f.service.addTrustEvidence(f.input.id, { ...base, id: "trust-1", trustClass: "restricted", verifiedBy: "getdone", reason: "validated", evidenceIds: [identity.id] }, command("trust"));
    await f.service.addHealthRecord(f.input.id, { ...base, id: "health-1", status: "healthy", method: "probe", source: "node", freshnessSeconds: 60 }, command("health"));
    await f.service.addCapabilityBinding(f.input.id, { ...base, id: "capability-1", capabilityName: "compute.cpu.light", adapterBinding: "linux", validated: true, evidenceIds: [identity.id] }, command("capability"));
    await f.service.addLocation(f.input.id, { ...base, id: "location-1", locationClass: "cloud", failureDomainIds: ["zone-1"] }, command("location"));
    await f.service.addCostProfile(f.input.id, { ...base, id: "cost-1", currency: "USD", source: "provider", estimatedHourlyCents: 1 }, command("cost"));
    await f.service.addProviderBinding(f.input.id, { ...base, id: "provider-1", providerId: "provider", adapterId: "linux", adapterVersion: "1", authenticated: true, status: "active" }, command("provider"));
    const ready = await f.service.markReady(f.input.id, command("ready"), timestamp);
    expect(ready).toMatchObject({ state: "ready", identityEvidenceIds: [identity.id], trustEvidenceIds: ["trust-1"], healthRecordIds: ["health-1"], capabilityBindingIds: ["capability-1"], locationIds: ["location-1"], costProfileIds: ["cost-1"], providerBindingIds: ["provider-1"] });
    expect(await f.service.readModel(f.input.id, command("read"), Date.parse(timestamp))).toMatchObject({ id: f.input.id });
    expect((await f.service.markDegraded(f.input.id, command("degrade"))).state).toBe("degraded");
    expect((await f.service.markUnreachable(f.input.id, command("unreachable"))).state).toBe("unreachable");
    expect((await f.service.disable(f.input.id, command("disable"))).state).toBe("disabled");
  });
  it.each(["resourceId", "portfolioId", "companyId"] as const)("rejects evidence for a foreign %s before persisting", async key => {
    const f = fixture(); await f.service.discover(f.input, command("discover"));
    const record = { id: "identity", resourceId: f.input.id, portfolioId: scope.portfolioId, companyId: scope.companyId, observedAt: timestamp, identityType: "manual" as const, subject: "node", verifier: "owner", verified: true, [key]: "foreign" };
    await expect(f.service.addIdentityEvidence(f.input.id, record, command("identity"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await f.stores.identities.listByResourceId(f.input.id)).toHaveLength(0);
  });
  it("rejects repeated in-progress evidence commands", async () => {
    const f = fixture(); await f.service.discover(f.input, command("discover"));
    const cmd = command("identity"); await f.idempotency.claim(cmd.idempotencyKey, commandFingerprint(cmd), timestamp);
    await expect(f.service.addIdentityEvidence(f.input.id, { id: "identity", resourceId: f.input.id, portfolioId: scope.portfolioId, companyId: scope.companyId, observedAt: timestamp, identityType: "manual", subject: "node", verifier: "owner", verified: true }, cmd)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
