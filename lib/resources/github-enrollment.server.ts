import { createHmac, sign } from "node:crypto";
import { z } from "zod";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { ControlApiPrincipal } from "@/lib/control-api/contracts";
import type { Resource } from "@/lib/domain/resources";
import type { ResourceRegistryService } from "@/lib/domain/services/resource-registry-service";
import type { ResourceEnrollmentService } from "@/lib/resources/enrollment";
import { githubRegistration } from "@/lib/credentials/github-app.server";
import { readBoundedJson } from "@/lib/execution/adapters/ordinary-integration-framework";

type Env = Readonly<Record<string, string | undefined>>;

export interface GithubResourceEnrollmentInput {
  repository: string;
  environment: "production";
  protectedBranches: readonly string[];
  idempotencyKey: string;
}

type ScopedResourceStore = {
  get(id: string): Promise<Resource | null>;
};

const installationSchema = z.object({
  id: z.number().int().positive().safe(),
  app_id: z.number().int().positive().safe(),
  suspended_at: z.string().datetime({ offset: true }).nullable(),
  permissions: z.record(z.enum(["read", "write", "admin"]))
});

const repositoryName = "DMART19/GetDone";
export const githubResourceId = "github-repository:DMART19.GetDone";

function required(env: Env, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new ControlPlaneError("UNAVAILABLE", `${name} is required`);
  return value;
}

function assertRequestedScope(input: GithubResourceEnrollmentInput) {
  if (input.repository !== repositoryName) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      `GitHub enrollment is limited to ${repositoryName} for the initial release`
    );
  }
  if (
    input.environment !== "production"
    || input.protectedBranches.length !== 1
    || input.protectedBranches[0] !== "main"
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "GitHub enrollment requires production scope with main protected"
    );
  }
}

function command(
  principal: ControlApiPrincipal,
  correlationId: string,
  phase: string,
  entityId: string
) {
  return createCommandEnvelope({
    commandId: crypto.randomUUID(),
    actor: principal.actor,
    scope: principal.scope,
    correlationId,
    environment: principal.scope.environment,
    idempotencyKey: `github-enrollment:${sha256Hex({
      portfolioId: principal.scope.portfolioId,
      companyId: principal.scope.companyId,
      resourceId: githubResourceId,
      phase
    })}`,
    provenance: "control-api:github-resource-enrollment",
    requestedMutation: {
      type: `github-resource-enrollment.${phase}`,
      resourceId: entityId
    }
  });
}

async function verifyInstallation(env: Env, fetcher: typeof fetch) {
  const registration = githubRegistration(env);
  const privateKey = required(env, "GETDONE_GITHUB_APP_PRIVATE_KEY_PEM");
  const timestamp = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: timestamp - 60,
    exp: timestamp + 300,
    iss: registration.appId
  })}`;
  const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
  const response = await fetcher(`https://api.github.com/repos/${repositoryName}/installation`, {
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28"
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      `GitHub App cannot access ${repositoryName} (HTTP ${response.status})`
    );
  }
  const parsed = installationSchema.safeParse(
    await readBoundedJson(response, 64_000).catch(() => undefined)
  );
  if (!parsed.success) {
    throw new ControlPlaneError("UNAVAILABLE", "GitHub installation returned an invalid response");
  }
  const installation = parsed.data;
  if (
    String(installation.id) !== registration.installationId
    || String(installation.app_id) !== registration.appId
    || installation.suspended_at !== null
    || !["write", "admin"].includes(installation.permissions.contents ?? "")
    || !["read", "write", "admin"].includes(installation.permissions.metadata ?? "")
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "GitHub App installation or repository permissions do not match GetDone"
    );
  }
  return registration;
}

export class GithubResourceEnrollmentService {
  constructor(private readonly deps: {
    resources: ScopedResourceStore;
    registry: ResourceRegistryService;
    enrollments: ResourceEnrollmentService;
    env: Env;
    fetcher?: typeof fetch;
    now?: () => Date;
  }) {}

  async enroll(principal: ControlApiPrincipal, input: GithubResourceEnrollmentInput) {
    assertRequestedScope(input);
    if (principal.scope.environment !== "production") {
      throw new ControlPlaneError("FORBIDDEN", "GitHub enrollment requires production scope");
    }
    const registration = await verifyInstallation(this.deps.env, this.deps.fetcher ?? fetch);
    if (
      principal.scope.portfolioId !== registration.portfolioId
      || principal.scope.companyId !== registration.companyId
    ) {
      throw new ControlPlaneError("FORBIDDEN", "GitHub connection belongs to another business scope");
    }
    if (!registration.binding.allowedResourceIds?.includes(githubResourceId)) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        `GitHub connection must authorize resource ${githubResourceId}`
      );
    }

    const current = await this.deps.resources.get(githubResourceId);
    if (current?.state === "ready") {
      if (
        current.portfolioId !== principal.scope.portfolioId
        || current.companyId !== principal.scope.companyId
        || current.providerId !== registration.providerId
        || !current.credentialBindingIds.includes(registration.binding.id)
      ) {
        throw new ControlPlaneError("CONFLICT", "Existing GitHub resource conflicts with this connection");
      }
      return current;
    }
    if (
      current
      && (
        current.portfolioId !== principal.scope.portfolioId
        || current.companyId !== principal.scope.companyId
        || current.providerId !== registration.providerId
        || !current.credentialBindingIds.includes(registration.binding.id)
      )
    ) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Existing GitHub resource conflicts with this connection"
      );
    }

    const now = (this.deps.now ?? (() => new Date()))().toISOString();
    const correlationId = crypto.randomUUID();
    const enrollmentId = `github-enrollment:${sha256Hex({
      portfolioId: principal.scope.portfolioId,
      companyId: principal.scope.companyId,
      repository: repositoryName
    }).slice(0, 32)}`;
    const challengeToken = createHmac(
      "sha256",
      required(this.deps.env, "GETDONE_CREDENTIAL_BROKER_TOKEN")
    ).update(enrollmentId).digest("hex");
    const evidenceId = (kind: string) => `${kind}:${sha256Hex({ enrollmentId, kind }).slice(0, 32)}`;
    const scoped = { resourceId: githubResourceId, portfolioId: principal.scope.portfolioId,
      companyId: principal.scope.companyId, observedAt: now };

    await this.deps.enrollments.identify({
      id: enrollmentId,
      requestedType: "cloud",
      requestedEnvironments: ["production"],
      ownerActionRequired: false,
      ownerActionDescription: "Verify the installed GetDone GitHub App",
      challengeToken,
      challengeExpiresAt: new Date(Date.parse(now) + 10 * 60_000).toISOString()
    }, command(principal, correlationId, "identify", enrollmentId));
    await this.deps.enrollments.createEnrollment(
      enrollmentId,
      command(principal, correlationId, "create", enrollmentId)
    );
    await this.deps.enrollments.authenticate(
      enrollmentId,
      command(principal, correlationId, "authenticate", enrollmentId),
      challengeToken,
      evidenceId("github-installation")
    );

    await this.deps.registry.discover({
      id: githubResourceId,
      type: "cloud",
      providerId: registration.providerId,
      environmentPermissions: ["production"],
      capabilityNames: registration.binding.capabilityNames,
      credentialBindingIds: [registration.binding.id],
      policyBindingIds: [
        `policy-configuration:${principal.scope.portfolioId}:${principal.scope.companyId}:production`
      ],
      trustClass: "production-eligible",
      dataClassesAllowed: ["public"],
      region: "github.com",
      architecture: "github-repository",
      discoveredAt: now
    }, command(principal, correlationId, "resource-discover", githubResourceId));
    await this.deps.enrollments.discover(
      enrollmentId,
      command(principal, correlationId, "enrollment-discover", enrollmentId),
      evidenceId("resource-discovery")
    );
    await this.deps.registry.beginEnrollment(
      githubResourceId,
      command(principal, correlationId, "resource-enrolling", githubResourceId)
    );
    await this.deps.registry.beginProfiling(
      githubResourceId,
      command(principal, correlationId, "resource-profiling", githubResourceId)
    );
    await this.deps.enrollments.profile(
      enrollmentId,
      command(principal, correlationId, "enrollment-profile", enrollmentId),
      evidenceId("github-profile")
    );
    await this.deps.registry.beginValidation(
      githubResourceId,
      command(principal, correlationId, "resource-validating", githubResourceId)
    );

    const identityId = evidenceId("github-identity");
    await this.deps.registry.addIdentityEvidence(githubResourceId, {
      ...scoped,
      id: identityId,
      identityType: "provider-account",
      subject: `repository:${repositoryName}`,
      verifier: `github-app:${registration.appId}`,
      verified: true
    }, command(principal, correlationId, "identity", githubResourceId));
    const trustId = evidenceId("github-trust");
    await this.deps.registry.addTrustEvidence(githubResourceId, {
      ...scoped,
      id: trustId,
      trustClass: "production-eligible",
      verifiedBy: `github-app:${registration.appId}`,
      reason: "Installed GitHub App identity and repository scope verified",
      evidenceIds: [identityId]
    }, command(principal, correlationId, "trust", githubResourceId));
    await this.deps.registry.addHealthRecord(githubResourceId, {
      ...scoped,
      id: evidenceId("github-health"),
      status: "healthy",
      method: "github-installation-api",
      source: "github",
      freshnessSeconds: 3600
    }, command(principal, correlationId, "health", githubResourceId));
    for (const capability of registration.binding.capabilityNames) {
      await this.deps.registry.addCapabilityBinding(githubResourceId, {
        ...scoped,
        id: evidenceId(`github-capability:${capability}`),
        capabilityName: capability,
        adapterBinding: "business.github@1.0.0",
        validated: true,
        evidenceIds: [identityId, trustId]
      }, command(principal, correlationId, `capability:${capability}`, githubResourceId));
    }
    await this.deps.registry.addLocation(githubResourceId, {
      ...scoped,
      id: evidenceId("github-location"),
      locationClass: "cloud",
      region: "github.com",
      site: repositoryName,
      failureDomainIds: []
    }, command(principal, correlationId, "location", githubResourceId));
    await this.deps.registry.addProviderBinding(githubResourceId, {
      ...scoped,
      id: evidenceId("github-provider"),
      providerId: registration.providerId,
      adapterId: "business.github",
      adapterVersion: "1.0.0",
      authenticated: true,
      status: "active"
    }, command(principal, correlationId, "provider", githubResourceId));
    await this.deps.enrollments.validate(
      enrollmentId,
      command(principal, correlationId, "enrollment-validate", enrollmentId),
      evidenceId("github-validation")
    );
    await this.deps.enrollments.test(
      enrollmentId,
      command(principal, correlationId, "enrollment-test", enrollmentId),
      evidenceId("github-health")
    );
    const ready = await this.deps.registry.markReady(
      githubResourceId,
      command(principal, correlationId, "resource-ready", githubResourceId),
      now
    );
    await this.deps.enrollments.register(
      enrollmentId,
      command(principal, correlationId, "enrollment-register", enrollmentId),
      githubResourceId,
      evidenceId("resource-registration")
    );
    await this.deps.enrollments.markReady(
      enrollmentId,
      command(principal, correlationId, "enrollment-ready", enrollmentId)
    );
    return ready;
  }
}
