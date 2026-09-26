import { describe, expect, it } from "vitest";
import {
  applyIntegrationVerification,
  assertManagedIntegrationScope,
  assertNoRawCredentialPayload,
  controlManagedIntegration,
  createIntegrationVerificationEvidence,
  createManagedIntegration,
  listIntegrationProviders,
  updateManagedIntegration
} from "@/lib/integrations/management";

const scope = {
  userId: "owner",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production" as const
};

describe("integration configuration management", () => {
  it("derives adapter identity and requested scopes from the server-side provider catalog", () => {
    const record = createManagedIntegration({
      id: "calendar-a",
      scope,
      config: {
        id: "calendar-a",
        providerId: "calendar",
        displayName: "Primary Calendar",
        credentialBindingId: "binding-calendar-prod",
        capabilityNames: [
          "calendar.event.read",
          "calendar.event.create"
        ]
      },
      createdAt: "2026-09-25T20:00:00Z"
    });

    expect(record).toMatchObject({
      providerId: "calendar",
      adapterId: "calendar-scheduling",
      adapterVersion: "1.0.0",
      companyId: "company-a",
      environment: "production",
      state: "configured",
      health: "unverified",
      requestedScopes: ["calendar.read", "calendar.write"],
      grantedScopes: []
    });
    expect(record.recordHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects raw credential material and unsupported provider capabilities", () => {
    expect(() => assertNoRawCredentialPayload({
      providerId: "calendar",
      token: "ghp_" + "x".repeat(30)
    })).toThrow(/credential/i);

    expect(() => createManagedIntegration({
      id: "calendar-secret",
      scope,
      config: {
        id: "calendar-secret",
        providerId: "calendar",
        displayName: "Unsafe",
        credentialBindingId: "Bearer " + "x".repeat(24),
        capabilityNames: ["calendar.event.read"]
      },
      createdAt: "2026-09-25T20:00:00Z"
    })).toThrow(/reference/i);

    expect(() => createManagedIntegration({
      id: "calendar-wrong-capability",
      scope,
      config: {
        id: "calendar-wrong-capability",
        providerId: "calendar",
        displayName: "Wrong",
        capabilityNames: ["github.repository.read"]
      },
      createdAt: "2026-09-25T20:00:00Z"
    })).toThrow(/not supported/i);
  });

  it("keeps requested scopes separate from granted scopes until verification proves them", () => {
    const record = createManagedIntegration({
      id: "calendar-a",
      scope,
      config: {
        id: "calendar-a",
        providerId: "calendar",
        displayName: "Calendar",
        credentialBindingId: "binding-calendar",
        capabilityNames: ["calendar.event.read", "calendar.event.update"]
      },
      createdAt: "2026-09-25T20:00:00Z"
    });
    expect(record.grantedScopes).toEqual([]);

    const evidence = createIntegrationVerificationEvidence({
      source: "integration-verifier",
      integrationId: record.id,
      portfolioId: record.portfolioId,
      companyId: record.companyId,
      environment: record.environment,
      providerId: record.providerId,
      adapterId: record.adapterId,
      adapterVersion: record.adapterVersion,
      verified: true,
      health: "healthy",
      grantedScopes: ["calendar.write", "calendar.read"],
      observedAt: "2026-09-25T20:05:00Z"
    });
    const verified = applyIntegrationVerification({ record, scope, evidence });
    expect(verified).toMatchObject({
      state: "connected",
      health: "healthy",
      grantedScopes: ["calendar.read", "calendar.write"],
      lastVerifiedAt: "2026-09-25T20:05:00.000Z",
      lastVerificationEvidenceHash: evidence.evidenceHash
    });

    const missingScopeEvidence = createIntegrationVerificationEvidence({
      ...evidence,
      grantedScopes: ["calendar.read"],
      observedAt: "2026-09-25T20:06:00Z"
    });
    expect(() => applyIntegrationVerification({
      record,
      scope,
      evidence: missingScopeEvidence
    })).toThrow(/required scope/i);
  });

  it("reconfiguration invalidates prior verification and revoke clears granted scopes", () => {
    const record = createManagedIntegration({
      id: "github-a",
      scope,
      config: {
        id: "github-a",
        providerId: "github",
        displayName: "GitHub",
        credentialBindingId: "binding-github",
        capabilityNames: ["github.repository.read"]
      },
      createdAt: "2026-09-25T20:00:00Z"
    });
    const evidence = createIntegrationVerificationEvidence({
      source: "integration-verifier",
      integrationId: record.id,
      portfolioId: record.portfolioId,
      companyId: record.companyId,
      environment: record.environment,
      providerId: record.providerId,
      adapterId: record.adapterId,
      adapterVersion: record.adapterVersion,
      verified: true,
      health: "healthy",
      grantedScopes: ["github.read"],
      observedAt: "2026-09-25T20:01:00Z"
    });
    const connected = applyIntegrationVerification({ record, scope, evidence });
    const updated = updateManagedIntegration({
      record: connected,
      scope,
      patch: {
        displayName: "GitHub Production",
        capabilityNames: ["github.repository.read", "github.issue.write"]
      },
      updatedAt: "2026-09-25T20:02:00Z"
    });
    expect(updated).toMatchObject({
      state: "configured",
      health: "unverified",
      grantedScopes: []
    });
    expect(updated.lastVerifiedAt).toBeUndefined();

    const revoked = controlManagedIntegration({
      record: connected,
      scope,
      action: "revoke",
      at: "2026-09-25T20:03:00Z"
    });
    expect(revoked).toMatchObject({
      state: "revoked",
      health: "revoked",
      grantedScopes: [],
      revokedAt: "2026-09-25T20:03:00.000Z"
    });
  });

  it("fails closed on tenant/environment drift and exposes the calendar catalog", () => {
    const record = createManagedIntegration({
      id: "calendar-a",
      scope,
      config: {
        id: "calendar-a",
        providerId: "calendar",
        displayName: "Calendar",
        capabilityNames: ["calendar.event.read"]
      },
      createdAt: "2026-09-25T20:00:00Z"
    });
    expect(() => assertManagedIntegrationScope(
      record,
      { ...scope, companyId: "company-b" }
    )).toThrow(/not found/i);

    expect(listIntegrationProviders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "calendar",
          adapterId: "calendar-scheduling",
          capabilities: expect.arrayContaining([
            "calendar.event.read",
            "calendar.event.create",
            "calendar.event.update",
            "calendar.event.cancel"
          ])
        })
      ])
    );
  });
});
