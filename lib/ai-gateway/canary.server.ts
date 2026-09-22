import { timingSafeEqual } from "node:crypto";
import {
  OpenRouterAIGatewayAdapter,
  readOpenRouterConfigFromEnv
} from "@/lib/ai-gateway/openrouter-adapter";
import {
  AI_GATEWAY_PRODUCTION_CONFIG_VERSION
} from "@/lib/ai-gateway/production-config";
import {
  readAIGatewayRuntimeConfig
} from "@/lib/ai-gateway/runtime.server";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  createAIGatewayCanaryEvidence,
  createAIGatewayRuntimeConfigEvidence,
  PostgresAIGatewayEvidenceStore
} from "@/lib/persistence/postgres/ai-audit-store";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";

function equalSecret(actual: string, expected: string) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function assertInternalAIGatewayToken(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const expected = env.GETDONE_INTERNAL_AI_TOKEN?.trim();
  if (!expected) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "GETDONE_INTERNAL_AI_TOKEN is required for internal AI operations"
    );
  }
  const authorization = request.headers.get("authorization");
  const actual = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (!actual || !equalSecret(actual, expected)) {
    throw new ControlPlaneError("UNAUTHENTICATED", "Internal AI authentication failed");
  }
}

export async function runLiveOpenRouterCanary(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now: () => Date = () => new Date()
) {
  const runtime = env.GETDONE_RUNTIME_ENV?.trim();
  if (runtime !== "staging" && runtime !== "production") {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Live OpenRouter canary is allowed only in staging or production"
    );
  }

  const config = readAIGatewayRuntimeConfig(env);
  if (config.policy.version !== AI_GATEWAY_PRODUCTION_CONFIG_VERSION) {
    throw new ControlPlaneError("FORBIDDEN", "OpenRouter canary routing config is stale");
  }

  const adapter = new OpenRouterAIGatewayAdapter(readOpenRouterConfigFromEnv(env));
  const database = getPostgresRuntimeFromEnv(env).database;
  const evidenceStore = new PostgresAIGatewayEvidenceStore(database);
  const recordedAt = now().toISOString();
  const configEvidence = createAIGatewayRuntimeConfigEvidence({
    configVersion: AI_GATEWAY_PRODUCTION_CONFIG_VERSION,
    routingPolicyVersion: config.policy.version,
    providerId: "openrouter",
    profiles: config.profiles,
    policy: config.policy,
    recordedAt
  });
  await evidenceStore.putConfig(configEvidence);

  const canary = await adapter.runCanary();
  if (!canary.enabled || !canary.ok) {
    throw new ControlPlaneError("UNAVAILABLE", "OpenRouter live canary is disabled");
  }

  const evidence = createAIGatewayCanaryEvidence({
    canaryId: crypto.randomUUID(),
    configHash: configEvidence.configHash,
    gatewayId: adapter.id,
    providerId: "openrouter",
    modelId: canary.modelId,
    ok: true,
    latencyMs: canary.latencyMs,
    observedAt: canary.observedAt
  });
  await evidenceStore.putCanary(evidence);
  return Object.freeze({
    provider: "openrouter",
    configVersion: AI_GATEWAY_PRODUCTION_CONFIG_VERSION,
    configHash: configEvidence.configHash,
    canary: evidence
  });
}
