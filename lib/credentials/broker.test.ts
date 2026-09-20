import { describe, expect, it } from "vitest";
import {
  assertCredentialLease,
  createCredentialBinding,
  createCredentialRequest,
  createSecretReference,
  issueCredentialLease,
  revokeCredentialLease
} from "@/lib/credentials/broker";

const scope = {
  userId: "owner-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production" as const,
  resourceId: "resource-cloud-a"
};

const secret = createSecretReference({
  id: "secret-mail-prod",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  providerId: "mail-provider",
  environment: "production",
  purpose: "email delivery",
  backendRef: "vault://mail/prod",
  status: "active",
  rotationVersion: 3
});

const binding = createCredentialBinding({
  id: "binding-mail-prod",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  providerId: "mail-provider",
  environment: "production",
  secretReferenceId: secret.id,
  capabilityNames: ["email.send"],
  grantedScopes: ["send", "status.read"],
  allowedLocationClasses: ["cloud", "colo"],
  status: "active"
});

function request(overrides: Record<string, unknown> = {}) {
  return createCredentialRequest({
    id: "credential-request-1",
    jobId: "job-1",
    placementRequestId: "placement-1",
    scope,
    resourceId: "resource-cloud-a",
    resourceState: "ready",
    resourceLocationClass: "cloud",
    providerId: "mail-provider",
    capability: "email.send",
    requestedScopes: ["send"],
    requestedAt: "2026-09-20T21:00:00Z",
    expiresAt: "2026-09-20T21:10:00Z",
    ...overrides
  } as Parameters<typeof createCredentialRequest>[0]);
}

describe("Phase 29 credential broker", () => {
  it("issues only the minimum requested scopes as a reference-only lease", () => {
    const lease = issueCredentialLease({
      leaseId: "lease-1",
      request: request(),
      secret,
      binding,
      deliveryRef: "delivery://lease-1",
      issuedAt: "2026-09-20T21:01:00Z",
      ttlSeconds: 120
    });

    expect(lease.grantedScopes).toEqual(["send"]);
    expect(lease).not.toHaveProperty("secret");
    expect(lease).not.toHaveProperty("token");
    expect(JSON.stringify(lease)).not.toContain("vault-secret-value");
    expect(assertCredentialLease(lease, {
      scope,
      jobId: "job-1",
      resourceId: "resource-cloud-a",
      capability: "email.send",
      now: Date.parse("2026-09-20T21:01:30Z")
    })).toBe(lease);
  });

  it("blocks Company A from obtaining Company B credentials", () => {
    const foreignSecret = createSecretReference({
      ...secret,
      id: "secret-company-b",
      companyId: "company-b",
      backendRef: "vault://company-b/prod"
    });

    expect(() => issueCredentialLease({
      leaseId: "lease-foreign",
      request: request(),
      secret: foreignSecret,
      binding: { ...binding, secretReferenceId: foreignSecret.id, companyId: "company-b" },
      deliveryRef: "delivery://lease-foreign",
      issuedAt: "2026-09-20T21:01:00Z",
      ttlSeconds: 60
    })).toThrow();
  });

  it("blocks staging scope from production secret references", () => {
    const stagingScope = { ...scope, environment: "staging" as const };
    expect(() => issueCredentialLease({
      leaseId: "lease-staging",
      request: request({ scope: stagingScope }),
      secret,
      binding,
      deliveryRef: "delivery://lease-staging",
      issuedAt: "2026-09-20T21:01:00Z",
      ttlSeconds: 60
    })).toThrow();
  });

  it("blocks a HOME resource from a data-center-only credential binding", () => {
    expect(() => issueCredentialLease({
      leaseId: "lease-home",
      request: request({ resourceLocationClass: "home" }),
      secret,
      binding,
      deliveryRef: "delivery://lease-home",
      issuedAt: "2026-09-20T21:01:00Z",
      ttlSeconds: 60
    })).toThrow();
  });

  it("blocks disabled resources and over-broad requested scopes", () => {
    expect(() => issueCredentialLease({
      leaseId: "lease-disabled",
      request: request({ resourceState: "disabled" }),
      secret,
      binding,
      deliveryRef: "delivery://lease-disabled",
      issuedAt: "2026-09-20T21:01:00Z",
      ttlSeconds: 60
    })).toThrow();

    expect(() => issueCredentialLease({
      leaseId: "lease-admin",
      request: request({ requestedScopes: ["send", "admin"] }),
      secret,
      binding,
      deliveryRef: "delivery://lease-admin",
      issuedAt: "2026-09-20T21:01:00Z",
      ttlSeconds: 60
    })).toThrow();
  });

  it("revocation invalidates the lease deterministically", () => {
    const lease = issueCredentialLease({
      leaseId: "lease-revoke",
      request: request(),
      secret,
      binding,
      deliveryRef: "delivery://lease-revoke",
      issuedAt: "2026-09-20T21:01:00Z",
      ttlSeconds: 120
    });
    const revoked = revokeCredentialLease(lease, "2026-09-20T21:01:30Z");

    expect(revoked.status).toBe("revoked");
    expect(() => assertCredentialLease(revoked, {
      scope,
      jobId: "job-1",
      resourceId: "resource-cloud-a",
      capability: "email.send",
      now: Date.parse("2026-09-20T21:01:40Z")
    })).toThrow();
  });
});
