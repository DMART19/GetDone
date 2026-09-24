import { describe, expect, it } from "vitest";
import {
  createCredentialBinding,
  createCredentialRequest,
  createSecretReference,
  issueCredentialLease,
  type CredentialLease,
  type CredentialUsageAudit
} from "@/lib/credentials/broker";
import {
  GovernedBusinessActionCredentialBroker,
  type CredentialDeliveryProvider
} from "@/lib/credentials/runtime-broker";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";

const now = new Date("2026-09-23T20:00:00Z");
const scope = {
  userId: "owner",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "staging" as const,
  resourceId: "resource-a"
};

function lease(): CredentialLease {
  const secret = createSecretReference({
    id: "secret-a",
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    providerId: "provider-a",
    environment: scope.environment,
    purpose: "staging",
    backendRef: "vault://provider/a",
    status: "active",
    rotationVersion: 1
  });
  const binding = createCredentialBinding({
    id: "binding-a",
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    providerId: "provider-a",
    environment: scope.environment,
    secretReferenceId: secret.id,
    capabilityNames: ["webhook.send"],
    grantedScopes: ["deliver", "verify"],
    allowedResourceIds: [scope.resourceId],
    allowedLocationClasses: ["cloud"],
    status: "active"
  });
  const request = createCredentialRequest({
    id: "credential-request-a",
    jobId: "job-a",
    placementRequestId: "placement-a",
    scope,
    resourceId: scope.resourceId,
    resourceState: "ready",
    resourceLocationClass: "cloud",
    providerId: "provider-a",
    capability: "webhook.send",
    requestedScopes: ["deliver", "verify"],
    requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 600_000).toISOString()
  });
  return issueCredentialLease({
    leaseId: "lease-a",
    request,
    secret,
    binding,
    deliveryRef: "delivery://provider/a",
    issuedAt: now.toISOString(),
    ttlSeconds: 300
  });
}

function action(overrides: Partial<AuthorizedBusinessActionRequest> = {}): AuthorizedBusinessActionRequest {
  const input = { companyId: "company-a", operation: "notify", payload: {} };
  return {
    id: "action-a",
    jobId: "job-a",
    scope,
    capability: "webhook.send",
    input,
    inputHash: sha256Hex(input),
    authorizationConsumptionHash: "consumption-a",
    credentialLeaseId: "lease-a",
    idempotencyKey: "idempotency-a",
    timeoutMs: 5_000,
    attempt: 1,
    ...overrides
  };
}

class MemoryLeaseReader {
  constructor(readonly value: CredentialLease | null) {}
  async get(id: string) {
    return this.value?.id === id ? this.value : null;
  }
}

class MemoryAudits {
  readonly values: CredentialUsageAudit[] = [];
  async append(value: CredentialUsageAudit) {
    this.values.push(value);
  }
}

class MemoryDelivery implements CredentialDeliveryProvider {
  constructor(private readonly overrides: Partial<Awaited<ReturnType<CredentialDeliveryProvider["redeem"]>>> = {}) {}
  async redeem(input: Parameters<CredentialDeliveryProvider["redeem"]>[0]) {
    return {
      material: "ephemeral-provider-material",
      expiresAt: new Date(now.getTime() + 120_000).toISOString(),
      providerId: input.lease.providerId,
      credentialVersion: input.lease.issuedCredentialVersion ?? 1,
      grantedScopes: [...input.requiredScopes],
      ...this.overrides
    };
  }
}

describe("governed business-action credential broker", () => {
  it("validates the persisted lease and returns short-lived material with a usage audit", async () => {
    const audits = new MemoryAudits();
    const broker = new GovernedBusinessActionCredentialBroker(
      new MemoryLeaseReader(lease()),
      audits,
      new MemoryDelivery(),
      () => now
    );

    const material = await broker.resolve({
      request: action(),
      requirement: {
        providerId: "provider-a",
        requiredScopes: ["deliver", "verify"]
      }
    });

    expect(material).toMatchObject({
      leaseId: "lease-a",
      providerId: "provider-a",
      capability: "webhook.send",
      material: "ephemeral-provider-material"
    });
    expect(audits.values).toHaveLength(1);
    expect(audits.values[0]).toMatchObject({
      leaseId: "lease-a",
      jobId: "job-a",
      action: "used"
    });
    expect(JSON.stringify(audits.values)).not.toContain("ephemeral-provider-material");
  });

  it("rejects provider, scope and requested-scope mismatches", async () => {
    const broker = new GovernedBusinessActionCredentialBroker(
      new MemoryLeaseReader(lease()),
      new MemoryAudits(),
      new MemoryDelivery(),
      () => now
    );

    await expect(broker.resolve({
      request: action(),
      requirement: { providerId: "provider-b", requiredScopes: ["deliver"] }
    })).rejects.toThrow(/provider/i);

    await expect(broker.resolve({
      request: action({
        scope: { ...scope, resourceId: "resource-b" }
      }),
      requirement: { providerId: "provider-a", requiredScopes: ["deliver"] }
    })).rejects.toThrow(/scope/i);

    await expect(broker.resolve({
      request: action(),
      requirement: { providerId: "provider-a", requiredScopes: ["admin"] }
    })).rejects.toThrow(/scopes/i);
  });

  it("rejects expired or identity-mismatched delivery material", async () => {
    const expired = new GovernedBusinessActionCredentialBroker(
      new MemoryLeaseReader(lease()),
      new MemoryAudits(),
      new MemoryDelivery({
        expiresAt: new Date(now.getTime() - 1).toISOString()
      }),
      () => now
    );
    await expect(expired.resolve({
      request: action(),
      requirement: { providerId: "provider-a", requiredScopes: ["deliver"] }
    })).rejects.toThrow(/invalid|expired/i);

    const wrongProvider = new GovernedBusinessActionCredentialBroker(
      new MemoryLeaseReader(lease()),
      new MemoryAudits(),
      new MemoryDelivery({ providerId: "provider-b" }),
      () => now
    );
    await expect(wrongProvider.resolve({
      request: action(),
      requirement: { providerId: "provider-a", requiredScopes: ["deliver"] }
    })).rejects.toThrow(/invalid|over-broad/i);
  });

  it("fails when the Job carries no lease reference or no trusted resource scope", async () => {
    const broker = new GovernedBusinessActionCredentialBroker(
      new MemoryLeaseReader(lease()),
      new MemoryAudits(),
      new MemoryDelivery(),
      () => now
    );

    await expect(broker.resolve({
      request: action({ credentialLeaseId: undefined }),
      requirement: { providerId: "provider-a", requiredScopes: ["deliver"] }
    })).rejects.toThrow(/lease reference/i);

    await expect(broker.resolve({
      request: action({ scope: { ...scope, resourceId: undefined } }),
      requirement: { providerId: "provider-a", requiredScopes: ["deliver"] }
    })).rejects.toThrow(/resource scope/i);
  });
});
