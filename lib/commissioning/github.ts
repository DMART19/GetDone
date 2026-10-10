import { sign } from "node:crypto";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { createAuditEvent } from "@/lib/domain/audit";
import { githubRegistration } from "@/lib/credentials/github-app.server";
import { readGithubProviderConfigurationsFromEnv } from "@/lib/execution/adapters/github-standard-operation";
import { readBoundedJson } from "@/lib/execution/adapters/ordinary-integration-framework";
import { activateIntegration, assertCompanyIntegrationIntegrity, beginIntegrationAuthentication, createCompanyIntegration } from "@/lib/integrations/registry";
import type { CompanyIntegration, IntegrationAuthenticationEvidence } from "@/lib/integrations/contracts";
import type { Resource } from "@/lib/domain/resources";
import { PostgresAuditLedger } from "@/lib/persistence/postgres/authority-stores";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

type Env = Readonly<Record<string, string | undefined>>;
/** Operator-only configuration, never a business execution or token-issuance path. */
export async function commissionGithub(db: PostgresTransactionalDatabase, env: Env, apply: boolean, fetcher = fetch) {
  if (env.GETDONE_RUNTIME_ENV !== "production") throw new Error("GitHub commissioning requires production configuration");
  const registration = githubRegistration(env);
  const userId = env.GETDONE_OWNER_USER_ID?.trim();
  const key = env.GETDONE_GITHUB_APP_PRIVATE_KEY_PEM;
  if (!userId || !key) throw new Error("Owner ID and GitHub App signing key are required");
  const configurations = readGithubProviderConfigurationsFromEnv(env);
  if (configurations.length !== 1) throw new Error("Narrow launch requires exactly one GitHub connection");
  const configuration = configurations[0];
  if (configuration.environment !== "production" || configuration.companyId !== registration.companyId
    || configuration.credentialProviderId !== registration.providerId
    || configuration.repositories.length !== 1 || configuration.repositories[0] !== "DMART19/GetDone"
    || !configuration.protectedBranches?.includes("main")
    || (configuration.apiBaseUrl && new URL(configuration.apiBaseUrl).href !== "https://api.github.com/")) {
    throw new Error("GitHub connection must match the owner, broker and protected repository");
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: timestamp - 60, exp: timestamp + 300, iss: registration.appId })}`;
  const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
  // This App-authenticated GET confirms repository installation and permissions;
  // it neither mints a provider token nor performs repository mutations.
  const response = await fetcher("https://api.github.com/repos/DMART19/GetDone/installation", {
    headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    redirect: "error", signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`GitHub installation verification failed (HTTP ${response.status})`);
  const installation = await readBoundedJson(response, 64_000) as {
    id: number; app_id: number; suspended_at: string | null; permissions: Record<string, string>;
  };
  if (String(installation.id) !== registration.installationId || String(installation.app_id) !== registration.appId
    || installation.suspended_at !== null
    || ["contents", "issues", "pull_requests"].some(permission => installation.permissions?.[permission] !== "write")) {
    throw new Error("GitHub installation identity, status, or required permissions do not match");
  }
  const scope = { userId, companyId: registration.companyId, portfolioId: registration.portfolioId, environment: "production" as const };
  return runWithPostgresTenantScope(scope, () => db.transaction(async client => {
    const owner = await client.query(`SELECT 1 FROM portfolio_memberships m JOIN auth_users u ON u.id=m.user_id
      WHERE m.user_id=$1 AND m.portfolio_id=$2 AND m.company_id=$3 AND m.role='owner' AND m.status='active' AND u.status='active'`,
    [userId, scope.portfolioId, scope.companyId]);
    if (owner.rowCount !== 1) throw new Error("Existing active owner membership is required");
    for (const id of registration.binding.allowedResourceIds ?? []) {
      const result = await client.query<{ payload: Resource }>("SELECT payload FROM control_plane_entities WHERE entity_type='resource' AND id=$1 FOR UPDATE", [id]);
      const resource = result.rows[0]?.payload;
      if (!resource || resource.portfolioId !== scope.portfolioId || resource.companyId !== scope.companyId
        || resource.state !== "ready" || resource.trustClass !== "production-eligible"
        || !resource.environmentPermissions.includes("production") || !resource.credentialBindingIds.includes(registration.binding.id)
        || registration.binding.capabilityNames.some(capability => !resource.capabilityNames.includes(capability))) {
        throw new Error(`Resource ${id} needs governed enrollment and matching production credential/capability bindings`);
      }
    }
    const id = `github-integration:${registration.providerId}`;
    const current = await client.query<{ payload: CompanyIntegration }>("SELECT payload FROM control_plane_entities WHERE entity_type='integration' AND id=$1 FOR UPDATE", [id]);
    const expected = {
      portfolioId: scope.portfolioId, companyId: scope.companyId, environment: scope.environment,
      adapterId: "business.github", credentialBindingId: registration.binding.id, connectionId: configuration.id
    };
    const existing = current.rows[0]?.payload;
    if (existing) {
      assertCompanyIntegrationIntegrity(existing);
      if (existing.state !== "connected" || existing.mock
        || existing.portfolioId !== expected.portfolioId || existing.companyId !== expected.companyId
        || existing.environment !== expected.environment || existing.adapterId !== expected.adapterId
        || existing.adapterVersion !== "1.0.0" || existing.accountIdentity !== `installation:${registration.installationId}`
        || JSON.stringify(existing.readScopes) !== JSON.stringify(["github.read"])
        || JSON.stringify(existing.writeScopes) !== JSON.stringify(["github.write"])
        || existing.credentialBindingId !== expected.credentialBindingId || existing.metadata.connectionId !== expected.connectionId
        || JSON.stringify([...existing.supportedCapabilities].sort()) !== JSON.stringify([...registration.binding.capabilityNames].sort())) {
        throw new Error("Existing integration conflicts with narrow-launch configuration; it was not overwritten");
      }
      return { status: "already-configured", integrationId: id, installationVerified: true, productionExecutionVerified: false };
    }
    if (!apply) return { status: "ready-to-configure", integrationId: id, installationVerified: true, productionExecutionVerified: false };
    const now = new Date().toISOString();
    const initial = createCompanyIntegration({ id, scope, kind: "github", displayName: "GetDone GitHub",
      adapterId: expected.adapterId, adapterVersion: "1.0.0", credentialBindingId: registration.binding.id,
      accountIdentity: `installation:${registration.installationId}`, supportedCapabilities: registration.binding.capabilityNames,
      readScopes: ["github.read"], writeScopes: ["github.write"], createdAt: now,
      health: { status: "healthy", observedAt: now }, metadata: { connectionId: configuration.id }
    });
    const proof: Omit<IntegrationAuthenticationEvidence, "evidenceHash"> = {
      source: "integration-adapter", integrationId: id, companyId: scope.companyId, environment: "production",
      adapterId: initial.adapterId, adapterVersion: initial.adapterVersion, authenticated: true,
      credentialBindingId: initial.credentialBindingId, observedAt: now
    };
    const record = activateIntegration({ record: beginIntegrationAuthentication(initial, scope, now), scope,
      evidence: { ...proof, evidenceHash: sha256Hex(proof) }, activatedAt: now });
    await client.query(`INSERT INTO control_plane_entities(entity_type,id,portfolio_id,company_id,version,updated_at,payload)
      VALUES('integration',$1,$2,$3,1,$4,$5::jsonb)`, [id,scope.portfolioId,scope.companyId,now,JSON.stringify(record)]);
    await new PostgresAuditLedger(client).append(createAuditEvent({
      correlationId: crypto.randomUUID(), eventType: "integration.commissioned", actor: { type: "user", id: userId }, scope,
      environment: "production", entityType: "integration", entityId: id, newState: "connected",
      provenance: "operator-cli:github-installation-verification", metadata: { installationId: registration.installationId, evidenceHash: sha256Hex(proof) }
    }));
    return { status: "configured", integrationId: id, installationVerified: true, productionExecutionVerified: false };
  }));
}
