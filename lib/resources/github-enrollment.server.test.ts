import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ControlApiPrincipal } from "@/lib/control-api/contracts";
import type { Resource } from "@/lib/domain/resources";
import type { ResourceRegistryService } from "@/lib/domain/services/resource-registry-service";
import type { ResourceEnrollmentService } from "@/lib/resources/enrollment";
import {
  GithubResourceEnrollmentService,
  githubResourceId,
} from "@/lib/resources/github-enrollment.server";

const now = "2026-10-13T17:00:00.000Z";
const portfolioId = "portfolio-owner";
const companyId = "company-owner";
const providerId = "github-production";
const bindingId = `github-binding:${providerId}`;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const principal: ControlApiPrincipal = {
  actor: { type: "user", id: "owner" },
  scope: { userId: "owner", portfolioId, companyId, environment: "production" },
  sessionId: "session",
  role: "owner",
};

function environment(resourceIds = [githubResourceId]) {
  return {
    GETDONE_OWNER_PORTFOLIO_ID: portfolioId,
    GETDONE_OWNER_COMPANY_ID: companyId,
    GETDONE_GITHUB_CREDENTIAL_PROVIDER_ID: providerId,
    GETDONE_GITHUB_APP_ID: "123",
    GETDONE_GITHUB_INSTALLATION_ID: "456",
    GETDONE_GITHUB_CREDENTIAL_RESOURCE_IDS_JSON: JSON.stringify(resourceIds),
    GETDONE_GITHUB_APP_PRIVATE_KEY_PEM: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    GETDONE_CREDENTIAL_BROKER_TOKEN: "test-only-broker-token-with-at-least-32-characters",
  };
}

function readyResource(state: Resource["state"] = "ready"): Resource {
  return {
    id: githubResourceId,
    portfolioId,
    companyId,
    type: "cloud",
    providerId,
    state,
    environmentPermissions: ["production"],
    capabilityNames: ["github.repository.read", "github.branch.create"],
    failureDomainIds: [],
    credentialBindingIds: [bindingId],
    policyBindingIds: [],
    identityEvidenceIds: [],
    trustEvidenceIds: [],
    healthRecordIds: [],
    capabilityBindingIds: [],
    locationIds: [],
    costProfileIds: [],
    providerBindingIds: [],
    trustClass: "production-eligible",
    dataClassesAllowed: ["public"],
    region: "github.com",
    architecture: "github-repository",
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

function githubResponse() {
  return Response.json({
    id: 456,
    app_id: 123,
    suspended_at: null,
    permissions: { contents: "write", metadata: "read" },
  });
}

function dependencies(current: Resource | null = null, resourceIds = [githubResourceId]) {
  const ready = readyResource();
  const registry = {
    discover: vi.fn(),
    beginEnrollment: vi.fn(),
    beginProfiling: vi.fn(),
    beginValidation: vi.fn(),
    addIdentityEvidence: vi.fn(),
    addTrustEvidence: vi.fn(),
    addHealthRecord: vi.fn(),
    addCapabilityBinding: vi.fn(),
    addLocation: vi.fn(),
    addProviderBinding: vi.fn(),
    markReady: vi.fn().mockResolvedValue(ready),
  };
  const enrollments = {
    identify: vi.fn(),
    createEnrollment: vi.fn(),
    authenticate: vi.fn(),
    discover: vi.fn(),
    profile: vi.fn(),
    validate: vi.fn(),
    test: vi.fn(),
    register: vi.fn(),
    markReady: vi.fn(),
  };
  return {
    registry,
    enrollments,
    service: new GithubResourceEnrollmentService({
      resources: { get: vi.fn().mockResolvedValue(current) },
      registry: registry as unknown as ResourceRegistryService,
      enrollments: enrollments as unknown as ResourceEnrollmentService,
      env: environment(resourceIds),
      fetcher: vi.fn().mockResolvedValue(githubResponse()) as unknown as typeof fetch,
      now: () => new Date(now),
    }),
  };
}

const input = {
  repository: "DMART19/GetDone",
  environment: "production" as const,
  protectedBranches: ["main"],
  idempotencyKey: "github-enrollment-request",
};

describe("governed GitHub resource enrollment", () => {
  it("verifies the installation and drives the existing enrollment and resource state machines", async () => {
    const { service, registry, enrollments } = dependencies();
    const result = await service.enroll(principal, input);

    expect(result).toEqual(readyResource());
    expect(enrollments.identify).toHaveBeenCalledTimes(1);
    expect(enrollments.authenticate).toHaveBeenCalledTimes(1);
    expect(registry.discover).toHaveBeenCalledWith(
      expect.objectContaining({
        id: githubResourceId,
        providerId,
        credentialBindingIds: [bindingId],
        environmentPermissions: ["production"],
      }),
      expect.any(Object),
    );
    expect(registry.markReady).toHaveBeenCalledWith(githubResourceId, expect.any(Object), now);
    expect(enrollments.markReady).toHaveBeenCalledTimes(1);
  });

  it("resumes an incomplete matching resource through idempotent phase commands", async () => {
    const { service, registry } = dependencies(readyResource("validating"));
    await expect(service.enroll(principal, input)).resolves.toEqual(readyResource());
    expect(registry.discover).toHaveBeenCalledTimes(1);
  });

  it("states the exact missing resource authorization without writing enrollment state", async () => {
    const { service, registry, enrollments } = dependencies(null, ["another-resource"]);
    await expect(service.enroll(principal, input)).rejects.toThrow(
      `GitHub connection must authorize resource ${githubResourceId}`,
    );
    expect(enrollments.identify).not.toHaveBeenCalled();
    expect(registry.discover).not.toHaveBeenCalled();
  });

  it("rejects repositories and branches outside the narrow registered scope before provider access", async () => {
    const { service, registry } = dependencies();
    await expect(service.enroll(principal, { ...input, repository: "DMART19/other" }))
      .rejects.toThrow("limited to DMART19/GetDone");
    await expect(service.enroll(principal, { ...input, protectedBranches: ["develop"] }))
      .rejects.toThrow("main protected");
    expect(registry.discover).not.toHaveBeenCalled();
  });
});
