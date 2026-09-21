import { describe, expect, it } from "vitest";
import {
  evaluateResourceReadiness,
  type Resource,
  type ResourceRegistryEvidenceSnapshot
} from "@/lib/domain/resources";

const now = Date.parse("2026-09-20T20:00:00Z");

const resource: Resource = {
  id: "resource-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  type: "compute",
  state: "validating",
  environmentPermissions: ["development", "staging"],
  capabilityNames: ["compute.cpu.light"],
  failureDomainIds: ["home-a"],
  credentialBindingIds: [],
  policyBindingIds: ["policy-1"],
  identityEvidenceIds: [],
  trustEvidenceIds: [],
  healthRecordIds: [],
  capabilityBindingIds: [],
  locationIds: [],
  costProfileIds: [],
  providerBindingIds: [],
  trustClass: "restricted",
  dataClassesAllowed: ["public", "internal"],
  createdAt: "2026-09-20T19:00:00Z",
  updatedAt: "2026-09-20T19:00:00Z",
  version: 1
};

const evidence: ResourceRegistryEvidenceSnapshot = {
  identities: [{
    id: "identity-1",
    resourceId: resource.id,
    portfolioId: resource.portfolioId,
    companyId: resource.companyId,
    identityType: "agent-key",
    subject: "pi-1",
    verifier: "getdone",
    verified: true,
    observedAt: "2026-09-20T19:50:00Z"
  }],
  trust: [{
    id: "trust-1",
    resourceId: resource.id,
    portfolioId: resource.portfolioId,
    companyId: resource.companyId,
    trustClass: "restricted",
    verifiedBy: "getdone",
    reason: "development node validated",
    evidenceIds: ["identity-1"],
    observedAt: "2026-09-20T19:51:00Z"
  }],
  health: [{
    id: "health-1",
    resourceId: resource.id,
    portfolioId: resource.portfolioId,
    companyId: resource.companyId,
    status: "healthy",
    method: "authenticated-heartbeat",
    source: "agent",
    freshnessSeconds: 300,
    observedAt: "2026-09-20T19:59:00Z"
  }],
  capabilities: [{
    id: "capability-1",
    resourceId: resource.id,
    portfolioId: resource.portfolioId,
    companyId: resource.companyId,
    capabilityName: "compute.cpu.light",
    adapterBinding: "linux-agent",
    validated: true,
    evidenceIds: ["benchmark-1"],
    observedAt: "2026-09-20T19:55:00Z"
  }],
  locations: [{
    id: "location-1",
    resourceId: resource.id,
    portfolioId: resource.portfolioId,
    companyId: resource.companyId,
    locationClass: "home",
    failureDomainIds: ["home-a"],
    observedAt: "2026-09-20T19:50:00Z"
  }],
  costs: [],
  providers: [{
    id: "provider-1",
    resourceId: resource.id,
    portfolioId: resource.portfolioId,
    companyId: resource.companyId,
    providerId: "local-agent",
    adapterId: "linux-agent",
    adapterVersion: "1",
    authenticated: true,
    status: "active",
    observedAt: "2026-09-20T19:52:00Z"
  }]
};

describe("resource registry readiness", () => {
  it("requires the complete authoritative evidence chain before READY", () => {
    expect(evaluateResourceReadiness(resource, evidence, now)).toEqual({
      ready: true,
      reasons: []
    });
  });

  it("rejects provider/agent capability claims that are not validated", () => {
    const result = evaluateResourceReadiness(resource, {
      ...evidence,
      capabilities: evidence.capabilities.map((item) => ({
        ...item,
        validated: false
      }))
    }, now);

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain(
      "validated-capability-required:compute.cpu.light"
    );
  });

  it("treats the newest capability evidence as authoritative", () => {
    const result = evaluateResourceReadiness(resource, {
      ...evidence,
      capabilities: [
        ...evidence.capabilities,
        {
          ...evidence.capabilities[0],
          id: "capability-2",
          validated: false,
          evidenceIds: ["capability-revoked"],
          observedAt: "2026-09-20T19:58:00Z"
        }
      ]
    }, now);

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain(
      "validated-capability-required:compute.cpu.light"
    );
  });

  it("rejects evidence from another company", () => {
    const result = evaluateResourceReadiness(resource, {
      ...evidence,
      identities: evidence.identities.map((item) => ({
        ...item,
        companyId: "company-b"
      }))
    }, now);

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("verified-resource-identity-required");
  });

  it("rejects stale health", () => {
    const result = evaluateResourceReadiness(resource, {
      ...evidence,
      health: evidence.health.map((item) => ({
        ...item,
        observedAt: "2026-09-20T18:00:00Z"
      }))
    }, now);

    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("fresh-healthy-status-required");
  });
});
