import { randomUUID, sign, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { assertTrustedExecutionScopeEqual } from "@/lib/control-plane/trusted-execution-scope";
import { assertAuthorizationConsumption, assertAuthorizationGrantEnvelope } from "@/lib/authorization/grants";
import { createCredentialBinding, createCredentialRequest, createSecretReference, issueCredentialLease, assertCredentialLease, releaseCredentialLease, createCredentialUsageAudit, type CredentialLease } from "@/lib/credentials/broker";
import { GovernedBusinessActionCredentialBroker, readCredentialDeliveryProviderFromEnv, type BusinessActionCredentialBroker } from "@/lib/credentials/runtime-broker";
import { GithubStandardOperationAdapter, readGithubProviderConfigurationsFromEnv } from "@/lib/execution/adapters/github-standard-operation";
import { assertAuthorizedBusinessActionRequest, type AuthorizedBusinessActionRequest, type BusinessActionCredentialMaterial } from "@/lib/execution/adapters/business-action";
import { readBoundedJson } from "@/lib/execution/adapters/ordinary-integration-framework";
import { PostgresCurrentExecutionAdmissionGate } from "@/lib/execution/current-execution-admission";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { TaskRecord } from "@/lib/domain/services/task-service";
import type { Resource } from "@/lib/domain/resources";
import { validateCapabilityInput } from "@/lib/domain/capabilities";
import type { CompanyIntegration } from "@/lib/integrations/contracts";
import type { DurableJobLease } from "@/lib/execution/job-runtime-contracts";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";
import { getTelemetry } from "@/lib/observability/telemetry";
import { PostgresAuthorizationGrantStore, PostgresEntityStore } from "@/lib/persistence/postgres/authority-stores";
import { PostgresCredentialBrokerStore } from "@/lib/persistence/postgres/credential-broker-store";
import { PostgresJobExecutionSpecStore } from "@/lib/persistence/postgres/job-execution-spec-store";

type Env = Readonly<Record<string, string | undefined>>;
const repository = "DMART19/GetDone";
const capabilities = ["github.repository.read", "github.branch.create", "github.commit.create", "github.pull-request.write", "github.issue.write"];

// A reference reserves no authority. Issuance happens only after the worker claim.
export function githubJobCredentialReference(jobId: string) {
  return `github-job:${sha256Hex({ jobId })}`;
}

export function githubRegistration(env: Env) {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new ControlPlaneError("UNAVAILABLE", `${name} is required`);
    return value;
  };
  const providerId = required("GETDONE_GITHUB_CREDENTIAL_PROVIDER_ID");
  const portfolioId = required("GETDONE_OWNER_PORTFOLIO_ID");
  const companyId = required("GETDONE_OWNER_COMPANY_ID");
  const appId = z.string().regex(/^\d+$/).parse(required("GETDONE_GITHUB_APP_ID"));
  const installationId = z.string().regex(/^\d+$/).parse(required("GETDONE_GITHUB_INSTALLATION_ID"));
  const resourceIds = z.array(z.string().min(1).max(256)).min(1).parse(
    JSON.parse(required("GETDONE_GITHUB_CREDENTIAL_RESOURCE_IDS_JSON"))
  );
  const secret = createSecretReference({
    id: `github-app:${providerId}`, portfolioId, companyId, providerId,
    environment: "production", purpose: "governed-github-execution",
    backendRef: `github-app://${appId}/installations/${installationId}`,
    status: "active", rotationVersion: 1
  });
  const binding = createCredentialBinding({
    id: `github-binding:${providerId}`, portfolioId, companyId, providerId,
    environment: "production", secretReferenceId: secret.id,
    capabilityNames: capabilities, grantedScopes: ["github.read", "github.write"],
    allowedResourceIds: resourceIds, allowedLocationClasses: ["cloud"], status: "active"
  });
  return { providerId, portfolioId, companyId, appId, installationId, secret, binding };
}

/** Re-read canonical authority, never trust a caller's broker token as execution authority. */
export async function assertGithubJobAuthority(db: SqlQueryable, request: AuthorizedBusinessActionRequest, env: Env, now = new Date()) {
  assertAuthorizedBusinessActionRequest(request);
  validateCapabilityInput(request.capability, request.input);
  const registration = githubRegistration(env);
  const persisted = await new PostgresJobExecutionSpecStore(db).get(request.jobId);
  if (!persisted) throw new ControlPlaneError("FORBIDDEN", "Persisted execution request is required");
  const { specHash, ...base } = persisted;
  if (sha256Hex(base) !== specHash || persisted.spec.kind !== "business-action"
    || sha256Hex(persisted.spec.request) !== sha256Hex(request)) {
    throw new ControlPlaneError("FORBIDDEN", "Credential request differs from persisted governed execution");
  }
  const job = await new PostgresEntityStore<JobRecord>(db, "job").get(request.jobId);
  if (!job || job.state !== "executing" || !job.authorizationGrantId || !job.authorizationConsumption
    || job.companyId !== registration.companyId || job.portfolioId !== registration.portfolioId
    || request.scope.environment !== "production"
    || job.authorizationConsumption.consumptionHash !== request.authorizationConsumptionHash) {
    throw new ControlPlaneError("FORBIDDEN", "Credential issuance requires the executing authorized Job");
  }
  const task = await new PostgresEntityStore<TaskRecord>(db, "task").get(job.taskId);
  const grant = await new PostgresAuthorizationGrantStore(db).get(job.authorizationGrantId);
  if (!task || !grant || !task.authorizationConsumption || !["queued", "running"].includes(task.state)
    || task.authorizationGrantId !== grant.id || task.authorizationGrantHash !== grant.grantHash
    || job.authorizationGrantHash !== grant.grantHash || task.companyId !== job.companyId
    || task.portfolioId !== job.portfolioId || task.authorizationConsumption.consumptionHash !== request.authorizationConsumptionHash) {
    throw new ControlPlaneError("FORBIDDEN", "Credential Task/grant lineage is invalid");
  }
  assertTrustedExecutionScopeEqual(grant.scope, request.scope, { requireSameResource: true });
  assertAuthorizationGrantEnvelope(grant, request.scope, now.getTime());
  assertAuthorizationConsumption(job.authorizationConsumption, grant);
  assertAuthorizationConsumption(task.authorizationConsumption, grant);
  if (job.authorizationConsumption.consumerId !== task.id || task.authorizationConsumption.consumerId !== task.id
    || job.authorizationConsumption.consumerType !== "task" || task.authorizationConsumption.consumerType !== "task") {
    throw new ControlPlaneError("FORBIDDEN", "Credential authorization consumer is invalid");
  }
  const active = await db.query<{ payload: DurableJobLease }>(
    "SELECT payload FROM job_leases WHERE job_id=$1 AND state='active'", [job.id]
  );
  const workerLease = active.rows[0]?.payload;
  if (!workerLease || active.rows.length !== 1) throw new ControlPlaneError("FORBIDDEN", "Active worker lease is required");
  const { leaseHash, ...workerBase } = workerLease;
  if (sha256Hex(workerBase) !== leaseHash || workerLease.workerId !== job.workerId
    || workerLease.attempt !== job.attempt || workerLease.state !== "active"
    || !Number.isFinite(Date.parse(workerLease.expiresAt)) || Date.parse(workerLease.expiresAt) <= now.getTime()) {
    throw new ControlPlaneError("FORBIDDEN", "Worker lease is expired or mismatched");
  }
  await new PostgresCurrentExecutionAdmissionGate(db, () => now).assertAllowed({
    scope: request.scope, grant, capability: request.capability, timeoutMs: request.timeoutMs, attempt: job.attempt
  });
  const input = request.input as Record<string, unknown>;
  if (!capabilities.includes(request.capability) || input.repository !== repository
    || ((request.capability === "github.branch.create" || request.capability === "github.commit.create") && input.branch === "main")) {
    throw new ControlPlaneError("POLICY_BLOCKED", "GitHub credential operation exceeds repository/branch policy");
  }
  const configurations = readGithubProviderConfigurationsFromEnv(env);
  const configuration = configurations.find((item) => item.id === input.connectionId);
  if (!configuration || configuration.credentialProviderId !== registration.providerId
    || configuration.repositories.length !== 1 || configuration.repositories[0] !== repository
    || !configuration.protectedBranches?.includes("main")
    || (configuration.apiBaseUrl && new URL(configuration.apiBaseUrl).href !== "https://api.github.com/")) {
    throw new ControlPlaneError("FORBIDDEN", "Registered GitHub connection is outside production scope");
  }
  const requirement = new GithubStandardOperationAdapter(configurations).credentialRequirement(request);
  const integration = (await db.query<{ payload: CompanyIntegration }>(
    "SELECT payload FROM control_plane_entities WHERE entity_type='integration' AND id=$1", [grant.integrationId]
  )).rows[0]?.payload;
  if (!integration || integration.credentialBindingId !== registration.binding.id
    || integration.metadata.connectionId !== configuration.id
    || !integration.supportedCapabilities.includes(request.capability)) {
    throw new ControlPlaneError("FORBIDDEN", "Current integration does not bind this credential provider/connection");
  }
  if (requirement.requiredScopes.some((scope) => !registration.binding.grantedScopes.includes(scope))) {
    throw new ControlPlaneError("FORBIDDEN", "GitHub credential scopes exceed registration");
  }
  const resource = await db.query<{ payload: Resource }>(
    "SELECT payload FROM control_plane_entities WHERE entity_type='resource' AND id=$1", [request.scope.resourceId]
  );
  const currentResource = resource.rows[0]?.payload;
  if (!currentResource || currentResource.state !== "ready" || currentResource.companyId !== job.companyId
    || currentResource.portfolioId !== job.portfolioId || currentResource.trustClass !== "production-eligible"
    || !currentResource.environmentPermissions.includes("production") || !currentResource.capabilityNames.includes(request.capability)
    || !currentResource.credentialBindingIds.includes(registration.binding.id)
    || !registration.binding.allowedResourceIds?.includes(request.scope.resourceId ?? "")) {
    throw new ControlPlaneError("FORBIDDEN", "Registered credential resource is not ready");
  }
  return { registration, grant, workerLease, requirement };
}

export class GithubJobCredentialBroker implements BusinessActionCredentialBroker {
  constructor(private readonly db: SqlQueryable, private readonly fallback: BusinessActionCredentialBroker, private readonly env: Env) {}

  async resolve(input: Parameters<BusinessActionCredentialBroker["resolve"]>[0]) {
    if (!input.request.capability.startsWith("github.")) return this.fallback.resolve(input);
    if (this.env.GETDONE_PROCESS_ROLE !== "job-worker") throw new ControlPlaneError("FORBIDDEN", "Only the dedicated worker may issue GitHub leases");
    const now = new Date();
    const { registration, grant, workerLease, requirement } = await assertGithubJobAuthority(this.db, input.request, this.env, now);
    if (sha256Hex(input.requirement) !== sha256Hex(requirement)) throw new ControlPlaneError("FORBIDDEN", "Credential requirement differs from the registered adapter");
    const request = createCredentialRequest({
      id: input.request.id, jobId: input.request.jobId, placementRequestId: workerLease.id,
      scope: input.request.scope, resourceId: input.request.scope.resourceId!, resourceState: "ready", resourceLocationClass: "cloud",
      providerId: registration.providerId, capability: input.request.capability, requestedScopes: requirement.requiredScopes,
      requestedAt: now.toISOString(), expiresAt: new Date(Math.min(Date.parse(grant.expiresAt), Date.parse(workerLease.expiresAt))).toISOString()
    });
    const lease = issueCredentialLease({
      leaseId: randomUUID(), request, secret: registration.secret, binding: registration.binding,
      deliveryRef: registration.secret.backendRef, issuedAt: now.toISOString(), ttlSeconds: 300
    });
    const store = new PostgresCredentialBrokerStore(this.db);
    await store.putLease(lease);
    await store.append(createCredentialUsageAudit({
      id: randomUUID(), leaseId: lease.id, leaseHash: lease.leaseHash, jobId: lease.jobId,
      resourceId: lease.resourceId, capability: lease.capability, providerId: lease.providerId,
      usedAt: now.toISOString(), action: "issued"
    }));
    return new GovernedBusinessActionCredentialBroker(store, store, readCredentialDeliveryProviderFromEnv(this.env))
      .resolve({ ...input, request: { ...input.request, credentialLeaseId: lease.id } });
  }

  async release(credential: BusinessActionCredentialMaterial) {
    if (credential.providerId !== this.env.GETDONE_GITHUB_CREDENTIAL_PROVIDER_ID) return this.fallback.release?.(credential);
    // GitHub installation tokens have a provider lifetime of one hour. Revoke after every call.
    let revoked = false;
    for (let attempt = 0; attempt < 2 && !revoked; attempt++) {
      try {
        const response = await fetch("https://api.github.com/installation/token", {
          method: "DELETE", headers: { authorization: `Bearer ${credential.material}`, accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(10_000), redirect: "error"
        });
        revoked = response.ok || response.status === 401;
        await response.body?.cancel();
      } catch { /* Bounded retry, without recording transport errors containing credentials. */ }
    }
    if (!revoked) {
      await getTelemetry().log("ERROR", "credential.revocation.failed", { "lease.id": credential.leaseId, "peer.service": "github" });
      // Preserve the action result so it cannot be replayed because cleanup failed.
      // This is an operational failure; the provider's fixed expiry remains the backstop.
      return;
    }
    const store = new PostgresCredentialBrokerStore(this.db);
    const lease = await store.get(credential.leaseId);
    if (!lease) throw new ControlPlaneError("FORBIDDEN", "Credential lease disappeared during release");
    await store.append(createCredentialUsageAudit({
      id: randomUUID(), leaseId: credential.leaseId, leaseHash: credential.leaseHash,
      jobId: lease.jobId,
      resourceId: lease.resourceId,
      capability: credential.capability, providerId: credential.providerId, usedAt: new Date().toISOString(), action: "released"
    }));
  }
}

export const githubDeliverySchema = z.object({
  portfolioId: z.string().min(1).max(256), companyId: z.string().min(1).max(256),
  deliveryRef: z.string().min(1).max(512), leaseId: z.string().min(1).max(256), leaseHash: z.string().regex(/^[a-f0-9]{64}$/),
  jobId: z.string().min(1).max(512), providerId: z.string().min(1).max(200), capability: z.string().min(1).max(100),
  requiredScopes: z.array(z.string().min(1).max(100)).min(1).max(10)
}).strict();

export function authenticateGithubDelivery(request: Request, env: Env) {
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const token = env.GETDONE_CREDENTIAL_BROKER_TOKEN?.trim();
  const expected = Buffer.from(`Bearer ${token ?? ""}`);
  if (!token || token.length < 32 || actual.length !== expected.length || !timingSafeEqual(actual, expected)
    || request.headers.has("origin") || request.headers.has("cookie")) {
    throw new ControlPlaneError("UNAUTHENTICATED", "Server-side broker authentication required");
  }
}

export async function deliverGithubCredential(db: SqlQueryable, input: z.infer<typeof githubDeliverySchema>, env: Env, fetchImpl: typeof fetch = fetch) {
  const store = new PostgresCredentialBrokerStore(db);
  const lease = await store.get(input.leaseId);
  const persisted = await new PostgresJobExecutionSpecStore(db).get(input.jobId);
  if (!lease || !persisted || persisted.spec.kind !== "business-action") throw new ControlPlaneError("FORBIDDEN", "Credential lease/job is unavailable");
  const request = persisted.spec.request;
  const { registration, requirement, workerLease } = await assertGithubJobAuthority(db, request, env);
  assertCredentialLease(lease, { scope: request.scope, jobId: request.jobId, resourceId: request.scope.resourceId!, capability: request.capability });
  if (lease.leaseHash !== input.leaseHash || lease.deliveryRef !== input.deliveryRef
    || lease.deliveryRef !== registration.secret.backendRef || lease.bindingId !== registration.binding.id
    || lease.secretReferenceId !== registration.secret.id || lease.placementRequestId !== workerLease.id
    || lease.requestId !== request.id || lease.providerId !== input.providerId || input.providerId !== registration.providerId
    || lease.companyId !== input.companyId || lease.portfolioId !== input.portfolioId || lease.capability !== input.capability
    || sha256Hex([...input.requiredScopes].sort()) !== sha256Hex([...requirement.requiredScopes].sort())
    || sha256Hex([...lease.grantedScopes].sort()) !== sha256Hex([...requirement.requiredScopes].sort())) {
    throw new ControlPlaneError("FORBIDDEN", "Credential redemption exceeds persisted authorization");
  }
  // Atomic, single redemption. A failed mint remains consumed; the worker can request a fresh lease.
  const released = releaseCredentialLease(lease, new Date().toISOString());
  const claimed = await db.query("UPDATE credential_leases SET status='released',lease_hash=$3,payload=$4::jsonb WHERE id=$1 AND status='active' AND lease_hash=$2 RETURNING id", [lease.id, lease.leaseHash, released.leaseHash, JSON.stringify(released)]);
  if (claimed.rowCount !== 1) throw new ControlPlaneError("FORBIDDEN", "Credential lease has already been redeemed");
  const delivered = await mintGithubInstallationToken(registration, request, lease, env, fetchImpl);
  try {
    // Recheck revocation, approval and worker ownership after the network round trip.
    const currentAuthority = await assertGithubJobAuthority(db, request, env);
    if (currentAuthority.workerLease.id !== workerLease.id) throw new ControlPlaneError("FORBIDDEN", "Worker ownership changed during credential delivery");
    if (Date.parse(lease.expiresAt) <= Date.now()) throw new ControlPlaneError("FORBIDDEN", "Credential lease expired during delivery");
    await store.append(createCredentialUsageAudit({
      id: `github-delivery:${lease.id}`, leaseId: lease.id, leaseHash: lease.leaseHash, jobId: lease.jobId,
      resourceId: lease.resourceId, capability: lease.capability, providerId: lease.providerId,
      credentialVersion: 1, providerExpiresAt: delivered.providerExpiresAt, usedAt: new Date().toISOString(), action: "used"
    }));
  } catch (error) {
    await fetchImpl("https://api.github.com/installation/token", {
      method: "DELETE", headers: { authorization: `Bearer ${delivered.material}` }, signal: AbortSignal.timeout(10_000), redirect: "error"
    }).catch(() => undefined);
    throw error;
  }
  return delivered;
}

export function githubPermissions(request: AuthorizedBusinessActionRequest): Record<string, "read" | "write"> {
  if (request.capability === "github.issue.write") return { issues: "write" };
  if (request.capability === "github.pull-request.write") return { pull_requests: "write" };
  if (request.capability === "github.branch.create" || request.capability === "github.commit.create") return { contents: "write" };
  if (request.capability !== "github.repository.read") throw new ControlPlaneError("FORBIDDEN", "GitHub capability is not registered");
  const operation = (request.input as { operation?: string }).operation;
  if (operation === "issue") return { issues: "read" };
  if (operation === "pull-request") return { pull_requests: "read" };
  if (operation === "checks") return { checks: "read", statuses: "read" };
  return { contents: "read" };
}

async function mintGithubInstallationToken(registration: ReturnType<typeof githubRegistration>, request: AuthorizedBusinessActionRequest, lease: CredentialLease, env: Env, fetchImpl: typeof fetch) {
  const key = env.GETDONE_GITHUB_APP_PRIVATE_KEY_PEM;
  if (!key) throw new ControlPlaneError("UNAVAILABLE", "GitHub App signing key is not configured");
  const timestamp = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: timestamp - 60, exp: timestamp + 540, iss: registration.appId })}`;
  const jwt = `${data}.${sign("RSA-SHA256", Buffer.from(data), key).toString("base64url")}`;
  const permissions = githubPermissions(request);
  const response = await fetchImpl(`https://api.github.com/app/installations/${registration.installationId}/access_tokens`, {
    method: "POST", headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" },
    body: JSON.stringify({ repositories: ["GetDone"], permissions }), signal: AbortSignal.timeout(10_000), redirect: "error"
  });
  if (!response.ok) throw new ControlPlaneError("UNAVAILABLE", `GitHub App token issuance failed with HTTP ${response.status}`);
  const value = await readBoundedJson(response, 64_000) as { token?: string; expires_at?: string; repositories?: { full_name: string }[]; permissions?: Record<string, string> };
  const expiry = Date.parse(value.expires_at ?? "");
  if (typeof value.token !== "string" || !value.token || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 3_660_000
    || value.repositories?.length !== 1 || value.repositories[0]?.full_name !== repository
    || !value.permissions || Object.entries(permissions).some(([key, permission]) => value.permissions?.[key] !== permission)
    || Object.entries(value.permissions).some(([key, permission]) => key === "metadata" ? permission !== "read" : permissions[key] !== permission)) {
    if (value.token) await fetchImpl("https://api.github.com/installation/token", { method: "DELETE", headers: { authorization: `Bearer ${value.token}` }, signal: AbortSignal.timeout(10_000), redirect: "error" }).catch(() => undefined);
    throw new ControlPlaneError("FORBIDDEN", "GitHub returned an invalid or over-scoped installation token");
  }
  return {
    material: value.token, providerId: lease.providerId, credentialVersion: 1, grantedScopes: lease.grantedScopes,
    // Effective GetDone authorization expiry is distinct from GitHub's fixed one-hour expiry.
    expiresAt: new Date(Math.min(expiry, Date.parse(lease.expiresAt))).toISOString(), providerExpiresAt: value.expires_at
  };
}
