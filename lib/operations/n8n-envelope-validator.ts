import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { canonicalSerialize } from "@/lib/control-plane/canonical-hash";
import { readGithubProviderConfigurationsFromEnv } from "@/lib/execution/adapters/github-standard-operation";

export type N8nEnvelope = {
  version: string;
  requestId: string;
  jobId: string;
  scope: { userId: string; portfolioId: string; companyId: string; environment: string };
  capability: string;
  parameters: Record<string, unknown>;
  inputHash: string;
  authorizationConsumptionHash: string;
  previewHash?: string;
  idempotencyKey: string;
  sentAt: string;
};

export type ValidatedN8nEnvelope = {
  envelope: N8nEnvelope;
  deploymentUrl?: string;
};

const deploymentConfigSchema = z.array(z.object({
  portfolioId: z.string().min(1),
  companyId: z.string().min(1),
  environment: z.enum(["development", "staging", "production"]),
  operation: z.string().min(1),
  connectionId: z.string().min(1),
  workflowUrl: z.string().url()
}).strict());

function reject(message: string): never {
  throw new ControlPlaneError("FORBIDDEN", message);
}

function required(env: Partial<NodeJS.ProcessEnv>, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new ControlPlaneError("UNAVAILABLE", `${name} is required`);
  return value;
}

function safeDeploymentUrl(env: Partial<NodeJS.ProcessEnv>) {
  const url = new URL(required(env, "GETDONE_DEPLOYMENT_HEALTH_TARGET_URL"));
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/api/health"
  ) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "Deployment health target must be a credential-free HTTPS /api/health endpoint"
    );
  }
  return url.toString();
}

export function validateN8nEnvelope(
  envelope: unknown,
  signature: string | null,
  env: Partial<NodeJS.ProcessEnv> = process.env
): ValidatedN8nEnvelope {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    reject("Invalid n8n envelope");
  }
  const value = envelope as Record<string, unknown>;
  const key = required(env, "GETDONE_N8N_SIGNING_KEY");
  if (key.length < 32) {
    throw new ControlPlaneError("UNAVAILABLE", "n8n signing key must contain at least 32 characters");
  }
  const expected = createHmac("sha256", key).update(canonicalSerialize(value)).digest("hex");
  if (
    !signature
    || !/^[a-f0-9]{64}$/.test(signature)
    || !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))
  ) reject("Invalid n8n signature");

  const sentAt = Date.parse(String(value.sentAt ?? ""));
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > 60_000) {
    reject("Expired n8n envelope");
  }
  const scope = value.scope as Record<string, unknown> | undefined;
  const parameters = value.parameters as Record<string, unknown> | undefined;
  if (
    !scope?.userId
    || !scope.portfolioId
    || !scope.companyId
    || !scope.environment
    || !parameters
    || !value.requestId
    || !value.jobId
    || !/^[a-f0-9]{64}$/.test(String(value.inputHash ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(value.authorizationConsumptionHash ?? ""))
    || !value.idempotencyKey
  ) reject("Incomplete n8n envelope");

  if (
    scope.userId !== required(env, "GETDONE_OWNER_USER_ID")
    || scope.portfolioId !== required(env, "GETDONE_OWNER_PORTFOLIO_ID")
    || scope.companyId !== required(env, "GETDONE_OWNER_COMPANY_ID")
    || scope.environment !== required(env, "GETDONE_RUNTIME_ENV")
    || parameters.companyId !== scope.companyId
  ) reject("n8n envelope is outside the configured owner scope");

  const capability = String(value.capability);
  const connectionId = String(parameters.connectionId ?? "");
  if (capability === "http.request") {
    let configured: unknown;
    try {
      configured = JSON.parse(required(env, "GETDONE_N8N_DEPLOYMENT_WORKFLOWS_JSON"));
    } catch {
      throw new ControlPlaneError("UNAVAILABLE", "Deployment workflow registration is invalid");
    }
    const registrations = deploymentConfigSchema.parse(configured);
    const registration = registrations.find((item) =>
      item.portfolioId === scope.portfolioId
      && item.companyId === scope.companyId
      && item.environment === scope.environment
      && item.connectionId === connectionId
    );
    if (
      !registration
      || parameters.operation !== registration.operation
      || Object.keys((parameters.payload as Record<string, unknown>) ?? {}).length > 0
    ) reject("Deployment health is outside the registered read-only scope");
    return { envelope: value as unknown as N8nEnvelope, deploymentUrl: safeDeploymentUrl(env) };
  }

  if (!["github.repository.read", "github.branch.create"].includes(capability)) {
    reject("Capability is outside the narrow n8n release");
  }
  const github = readGithubProviderConfigurationsFromEnv(env).find((item) =>
    item.id === connectionId
    && item.companyId === scope.companyId
    && item.environment === scope.environment
  );
  if (!github || !github.repositories.includes(String(parameters.repository ?? ""))) {
    reject("Repository is not registered for this business connection");
  }
  if (capability === "github.repository.read") {
    if (!["repository", "checks"].includes(String(parameters.operation ?? ""))) {
      reject("Repository health permits repository and checks reads only");
    }
  } else {
    const branch = String(parameters.branch ?? "");
    if (
      !/^[a-f0-9]{64}$/.test(String(value.previewHash ?? ""))
      || !/^[a-f0-9]{40}$/.test(String(parameters.expectedSourceSha ?? ""))
      || !/^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]+$/.test(branch)
      || ["main", "master", ...(github.protectedBranches ?? [])].includes(branch)
    ) reject("Branch creation is outside the approved non-protected scope");
  }
  return { envelope: value as unknown as N8nEnvelope };
}
