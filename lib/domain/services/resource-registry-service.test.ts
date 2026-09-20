import { describe, expect, it } from "vitest";
import {
  assertResourceReadyEligibility
} from "@/lib/domain/services/resource-registry-service";
import type { ResourceRegistryReadModel } from "@/lib/domain/resources";

const now = Date.parse("2026-09-20T20:00:00Z");

function readyModel(): ResourceRegistryReadModel {
  return {
    resource: {
      id: "resource-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      type: "compute",
      state: "validating",
      environmentPermissions: ["staging"],
      capabilityNames: ["compute.cpu.light"],
      failureDomainIds: ["home-a"],
      credentialBindingIds: [],
      policyBindingIds: ["policy-1"],
      trustClass: "restricted",
      dataClassesAllowed: ["public", "internal"],
      createdAt: "2026-09-20T18:00:00Z",
      updatedAt: "2026-09-20T19:00:00Z",
      version: 3
    },
    identityEvidence: [{
      id: "identity-1",
      resourceId: "resource-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      subjectHash: "sha256-subject",
      verifier: "getdone-enrollment",
      status: "verified",
      verifiedAt: "2026-09-20T19:00:00Z",
      expiresAt: "2026-09-21T20:00:00Z"
    }],
    trustEvidence: [{
      id: "trust-1",
      resourceId: "resource-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      classification: "restricted",
      status: "accepted",
      evidenceIds: ["identity-1"],
      assessedAt: "2026-09-20T19:05:00Z",
      expiresAt: "2026-09-21T20:00:00Z"
    }],
    healthRecords: [{
      id: "health-1",
      resourceId: "resource-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      state: "healthy",
      healthMethod: "authenticated-heartbeat",
      observedAt: "2026-09-20T19:59:00Z",
      expiresAt: "2026-09-20T20:05:00Z",
      evidenceIds: ["heartbeat-1"]
    }],
    capabilityBindings: [{
      id: "capability-1",
      resourceId: "resource-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      capabilityName: "compute.cpu.light",
      adapterBindingId: "adapter-1",
      status: "validated",
      validationEvidenceIds: ["canary-1"],
      validatedAt: "2026-09-20T19:30:00Z"
    }],
    locations: [],
    costProfiles: [],
    providerBindings: [{
      id: "provider-1",
      resourceId: "resource-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      providerId: "local-linux",
      adapterBindingId: "adapter-1",
      status: "active"
    }]
  };
}

describe("resource registry ready gate", () => {
  it("accepts a resource only when identity, trust, health, capability, policy and adapter evidence exist", () => {
    expect(assertResourceReadyEligibility(readyModel(), now).resource.id).toBe("resource-1");
  });

  it("fails closed when identity evidence is missing", () => {
    const model = readyModel();
    model.identityEvidence = [];
    expect(() => assertResourceReadyEligibility(model, now)).toThrow();
  });

  it("fails closed on stale health", () => {
    const model = readyModel();
    model.healthRecords = [{ ...model.healthRecords[0], expiresAt: "2026-09-20T19:59:30Z" }];
    expect(() => assertResourceReadyEligibility(model, now)).toThrow();
  });

  it("does not accept provider binding without an adapter binding", () => {
    const model = readyModel();
    model.providerBindings = [{ ...model.providerBindings[0], adapterBindingId: "" }];
    expect(() => assertResourceReadyEligibility(model, now)).toThrow();
  });
});
