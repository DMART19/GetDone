import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { createAuthorizationConsumptionRecord, type AuthorizationGrant } from "@/lib/authorization/grants";
import { CAPABILITY_REGISTRY_HASH, CAPABILITY_REGISTRY_VERSION, requireEnabledCapability } from "@/lib/domain/capabilities";
import { CURRENT_POLICY_VERSION, CURRENT_POLICY_REGISTRY_HASH } from "@/lib/domain/policy-registry";
import { POLICY_ENGINE_VERSION, POLICY_RULES_HASH } from "@/lib/planning/policy-engine";
import { createDurableJobLease } from "@/lib/execution/job-runtime-contracts";
import { createPersistedJobExecutionSpec } from "@/lib/execution/job-execution-router";
import { createCredentialRequest, issueCredentialLease } from "@/lib/credentials/broker";
import { authenticateGithubDelivery, assertGithubJobAuthority, deliverGithubCredential, GithubJobCredentialBroker, githubRegistration, githubPermissions, githubJobCredentialReference } from "@/lib/credentials/github-app.server";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import { createCompanyIntegration } from "@/lib/integrations/registry";

const now = new Date("2026-10-07T12:00:00Z");
const scope = { userId: "owner", portfolioId: "portfolio", companyId: "company", environment: "production" as const, resourceId: "worker-resource" };
const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const env = {
  GETDONE_OWNER_COMPANY_ID: scope.companyId, GETDONE_OWNER_PORTFOLIO_ID: scope.portfolioId,
  GETDONE_GITHUB_CREDENTIAL_PROVIDER_ID: "github-app", GETDONE_GITHUB_APP_ID: "123", GETDONE_GITHUB_INSTALLATION_ID: "456",
  GETDONE_GITHUB_CREDENTIAL_RESOURCE_IDS_JSON: JSON.stringify([scope.resourceId]), GETDONE_GITHUB_APP_PRIVATE_KEY_PEM: key,
  GETDONE_CREDENTIAL_BROKER_TOKEN: "fixture-broker-token-with-at-least-32-characters",
  GETDONE_CREDENTIAL_DELIVERY_URL: "https://getdone.test/api/internal/credentials/github",
  GETDONE_GITHUB_ACTIONS_JSON: JSON.stringify([{ id: "github-production", companyId: scope.companyId, environment: "production", credentialProviderId: "github-app", repositories: ["DMART19/GetDone"], protectedBranches: ["main"] }])
};

function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const grantBase: Omit<AuthorizationGrant, "grantHash"> = {
    id: "grant", status: "active", disposition: "APPROVAL_REQUIRED", scope, planId: "plan", planVersion: 1,
    planHash: "plan-hash", stepId: "step", stepHash: "step-hash", capabilityNames: ["github.branch.create"],
    integrationId: "integration", executionLimits: { environment: "production", expectedDurationSeconds: 30, retryable: true },
    validationReceiptId: "validation", validationReceiptHash: "validation-hash", policySnapshotId: "policy", policySnapshotHash: "policy-hash",
    policyVersion: CURRENT_POLICY_VERSION, policyRegistryHash: CURRENT_POLICY_REGISTRY_HASH, policyEngineVersion: POLICY_ENGINE_VERSION,
    policyRulesHash: POLICY_RULES_HASH, capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION, capabilityRegistryHash: CAPABILITY_REGISTRY_HASH,
    decisionId: "decision", approvalProofId: "approval", approvalProofHash: "approval-hash", actor: { type: "user", id: "owner" },
    issuedAt: new Date(now.getTime() - 60_000).toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString()
  };
  const grant = { ...grantBase, grantHash: sha256Hex(grantBase) };
  const consumption = createAuthorizationConsumptionRecord({ id: "authorization-consumption:grant", grant, consumerType: "task", consumerId: "task", consumedAt: now.toISOString() });
  const input = { companyId: scope.companyId, connectionId: "github-production", repository: "DMART19/GetDone", branch: "commissioning-test", fromRef: "main" };
  const request: AuthorizedBusinessActionRequest = { id: "request", jobId: "job", scope, capability: "github.branch.create", input, inputHash: sha256Hex(input), authorizationConsumptionHash: consumption.consumptionHash, credentialLeaseId: githubJobCredentialReference("job"), idempotencyKey: "request", timeoutMs: 10_000, attempt: 1 };
  const job = { id: "job", state: "executing", taskId: "task", workerId: "worker", attempt: 1, companyId: scope.companyId, portfolioId: scope.portfolioId, authorizationGrantId: grant.id, authorizationGrantHash: grant.grantHash, authorizationConsumption: consumption };
  const task = { id: "task", state: "running", companyId: scope.companyId, portfolioId: scope.portfolioId, authorizationGrantId: grant.id, authorizationGrantHash: grant.grantHash, authorizationConsumption: consumption };
  const workerLease = { ...createDurableJobLease({ id: "worker-lease", jobId: "job", workerId: "worker", attempt: 1, leaseIssuedAt: now.toISOString(), leaseSeconds: 120 }) };
  const registration = githubRegistration(env);
  const lease = issueCredentialLease({ leaseId: "credential-lease", request: createCredentialRequest({ id: request.id, jobId: "job", placementRequestId: workerLease.id, scope, resourceId: scope.resourceId, resourceState: "ready", resourceLocationClass: "cloud", providerId: registration.providerId, capability: request.capability, requestedScopes: ["github.read", "github.write"], requestedAt: now.toISOString(), expiresAt: workerLease.expiresAt }), secret: registration.secret, binding: registration.binding, deliveryRef: registration.secret.backendRef, issuedAt: now.toISOString(), ttlSeconds: 120 });
  const decision = { id: "decision", portfolioId: scope.portfolioId, companyId: scope.companyId, status: "approved", approvalProof: { proofHash: "approval-hash" } };
  const resource = { id: scope.resourceId, companyId: scope.companyId, portfolioId: scope.portfolioId, state: "ready", trustClass: "production-eligible", environmentPermissions: ["production"], capabilityNames: [request.capability], credentialBindingIds: [registration.binding.id] };
  const disconnected = createCompanyIntegration({ id: "integration", scope, kind: "github", provider: "github", displayName: "GitHub", adapterId: requireEnabledCapability(request.capability).adapterBinding, adapterVersion: "1.0.0", accountIdentity: "DMART19", supportedCapabilities: [request.capability], credentialBindingId: registration.binding.id, metadata: { connectionId: "github-production" }, readScopes: ["github.read"], writeScopes: ["github.write"], createdAt: now.toISOString() });
  const { recordHash: _hash, ...integrationBase } = disconnected;
  void _hash;
  const connectedBase = { ...integrationBase, state: "connected" as const };
  const integration = { ...connectedBase, recordHash: sha256Hex(connectedBase) };
  let spec = createPersistedJobExecutionSpec({ kind: "business-action", jobId: "job", authoritativeJobVersion: 1, authoritativeJobHash: "job-hash", request });
  const leases = new Map([[lease.id, lease]]);
  const redeemed = new Set<string>();
  const db = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
    let payload: unknown;
    if (sql.startsWith("INSERT INTO credential_leases")) {
      const inserted = JSON.parse(String(values?.[10])); leases.set(inserted.id, inserted);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE credential_leases")) { const id = String(values?.[0]); const changed = !redeemed.has(id); redeemed.add(id); return { rows: changed ? [{ id }] : [], rowCount: changed ? 1 : 0 }; }
    if (sql.includes("FROM credential_leases")) payload = leases.get(String(values?.[0]));
    else if (sql.includes("FROM job_execution_specs")) payload = spec;
    else if (sql.includes("FROM authorization_grants")) payload = grant;
    else if (sql.includes("FROM job_leases")) payload = workerLease;
    else if (sql.includes("entity_type='decision'")) payload = decision;
    else if (sql.includes("entity_type='integration'")) payload = integration;
    else if (sql.includes("entity_type='resource'")) payload = resource;
    else if (sql.includes("entity_type = $1")) {
      payload = values?.[0] === "job" ? job : values?.[0] === "integration" ? integration : task;
    }
    return { rows: payload ? [{ payload }] : [], rowCount: payload ? 1 : 0 };
  }) };
  const delivery = { portfolioId: scope.portfolioId, companyId: scope.companyId, deliveryRef: lease.deliveryRef, leaseId: lease.id, leaseHash: lease.leaseHash, jobId: "job", providerId: lease.providerId, capability: request.capability, requiredScopes: ["github.read", "github.write"] };
  return { db: db as unknown as SqlQueryable, request, delivery, job, task, decision, workerLease, grant, resource, lease, setSpec: () => { spec = createPersistedJobExecutionSpec({ ...spec.spec, kind: "business-action", request } as Extract<typeof spec.spec, { kind: "business-action" }>); } };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("production GitHub App credential delivery", () => {
  it("rejects broker-only access without the server bearer and refuses browser requests", () => {
    expect(() => authenticateGithubDelivery(new Request("https://getdone.test"), env)).toThrow();
    expect(() => authenticateGithubDelivery(new Request("https://getdone.test", { headers: { authorization: `Bearer ${env.GETDONE_CREDENTIAL_BROKER_TOKEN}`, origin: "https://getdone.test" } }), env)).toThrow();
    expect(() => authenticateGithubDelivery(new Request("https://getdone.test", { headers: { authorization: `Bearer ${env.GETDONE_CREDENTIAL_BROKER_TOKEN}` } }), env)).not.toThrow();
  });

  it("checks persisted approvals and worker authority and mints a single-repository token once", async () => {
    const f = fixture();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ token: "ghs_fixture", expires_at: new Date(now.getTime() + 3_600_000).toISOString(), repositories: [{ full_name: "DMART19/GetDone" }], permissions: { contents: "write", metadata: "read" } }));
    const result = await deliverGithubCredential(f.db, f.delivery, env, fetcher);
    expect(result.material).toBe("ghs_fixture");
    expect(result.expiresAt).toBe(f.lease.expiresAt);
    expect(result.providerExpiresAt).not.toBe(result.expiresAt);
    const init = fetcher.mock.calls[0]?.[1] as unknown as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ repositories: ["GetDone"], permissions: { contents: "write" } });
    await expect(deliverGithubCredential(f.db, f.delivery, env, fetcher)).rejects.toThrow(/redeemed/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(f.db.query).mock.calls)).not.toContain("ghs_fixture");
  });

  it("issues and audits a worker lease, redeems through the HTTP boundary, and revokes the token", async () => {
    const f = fixture();
    const providerFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ token: "ghs_worker_fixture", expires_at: new Date(now.getTime() + 3_600_000).toISOString(), repositories: [{ full_name: "DMART19/GetDone" }], permissions: { contents: "write", metadata: "read" } }));
    const transport = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url) === "https://api.github.com/installation/token") return new Response(null, { status: 204 });
      expect(String(url)).toBe(env.GETDONE_CREDENTIAL_DELIVERY_URL);
      const request = new Request(String(url), init);
      authenticateGithubDelivery(request, env);
      return Response.json(await deliverGithubCredential(f.db, JSON.parse(String(init?.body)), env, providerFetch));
    });
    vi.stubGlobal("fetch", transport);
    const broker = new GithubJobCredentialBroker(f.db, { resolve: vi.fn() }, { ...env, GETDONE_PROCESS_ROLE: "job-worker" });
    const material = await broker.resolve({ request: f.request, requirement: { providerId: "github-app", requiredScopes: ["github.write", "github.read"] } });
    expect(material.material).toBe("ghs_worker_fixture");
    await broker.release(material);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const persistence = JSON.stringify(vi.mocked(f.db.query).mock.calls);
    expect(persistence).toContain("github-delivery:");
    expect(persistence).not.toContain("ghs_worker_fixture");
  });

  it("revokes over-scoped provider responses instead of delivering them", async () => {
    const f = fixture();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ token: "ghs_overbroad", expires_at: new Date(now.getTime() + 3_600_000).toISOString(), repositories: [{ full_name: "DMART19/GetDone" }], permissions: { contents: "write", administration: "write" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(deliverGithubCredential(f.db, f.delivery, env, fetcher)).rejects.toThrow(/over-scoped/);
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://api.github.com/installation/token");
  });

  it.each(["approval", "cancelled", "expired-worker", "foreign-tenant", "resource", "tampered-request", "main", "repository", "scope"])("denies %s before calling GitHub", async (failure) => {
    const f = fixture();
    if (failure === "approval") f.decision.status = "rejected";
    if (failure === "cancelled") f.job.state = "cancelled";
    if (failure === "expired-worker") Object.assign(f.workerLease, { expiresAt: new Date(now.getTime() - 1).toISOString() });
    if (failure === "foreign-tenant") f.delivery.companyId = "another-company";
    if (failure === "resource") f.resource.state = "quarantined";
    if (failure === "tampered-request") f.request.inputHash = "tampered";
    if (failure === "main" || failure === "repository") {
      Object.assign(f.request.input as object, failure === "main" ? { branch: "main" } : { repository: "DMART19/Other" });
      f.request.inputHash = sha256Hex(f.request.input); f.setSpec();
    }
    if (failure === "scope") f.delivery.requiredScopes.push("admin");
    const fetcher = vi.fn();
    await expect(deliverGithubCredential(f.db, f.delivery, env, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not accept a caller-created execution request", async () => {
    const f = fixture();
    await expect(assertGithubJobAuthority(f.db, { ...f.request, jobId: "other-job" }, env)).rejects.toThrow();
  });

  it("requests operation-specific provider permissions and never grants merge authority", () => {
    const f = fixture();
    expect(githubPermissions({ ...f.request, capability: "github.issue.write" })).toEqual({ issues: "write" });
    expect(() => githubPermissions({ ...f.request, capability: "github.pull-request.merge" })).toThrow();
  });
});
