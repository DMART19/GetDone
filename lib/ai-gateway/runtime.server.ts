import { z } from "zod";
import { AIGateway } from "@/lib/ai-gateway/gateway";
import type { ModelProfile, ModelRoutePolicy } from "@/lib/ai-gateway/contracts";
import {
  OpenRouterAIGatewayAdapter,
  readOpenRouterConfigFromEnv
} from "@/lib/ai-gateway/openrouter-adapter";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { parseAuthoritativeRuntimeEnvironment } from "@/lib/control-plane/runtime-environment";
import { PostgresAIGatewayHealthStore } from "@/lib/persistence/postgres/ai-gateway-health-store";
import { PostgresAICallAuditStore } from "@/lib/persistence/postgres/ai-audit-store";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";

const profileSchema = z.object({
  id: z.string().min(1),
  gatewayId: z.literal("openrouter"),
  providerId: z.literal("openrouter"),
  modelId: z.string().min(1),
  enabled: z.boolean(),
  validationStatus: z.enum(["validated", "unvalidated", "failed"]),
  roles: z.array(z.enum(["LIGHTWEIGHT", "STANDARD", "HIGH_REASONING", "CODING", "VISION", "LONG_CONTEXT"])),
  modalities: z.array(z.enum(["text", "image"])),
  supportsTools: z.boolean(),
  supportsStructuredOutput: z.boolean(),
  maxContextTokens: z.number().int().positive(),
  allowedDataClasses: z.array(z.enum(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"])),
  allowedEnvironments: z.array(z.enum(["development", "staging", "production"])),
  health: z.enum(["healthy", "degraded", "disabled"]),
  latencyClass: z.enum(["low", "standard", "high"]),
  inputCostPerMillionTokensCents: z.number().nonnegative(),
  outputCostPerMillionTokensCents: z.number().nonnegative(),
  profileVersion: z.string().min(1)
}).strict();

const policySchema = z.object({
  version: z.string().min(1),
  routes: z.record(z.array(z.string().min(1)))
}).strict();

function parseJson(value: string | undefined, label: string) {
  if (!value?.trim()) throw new ControlPlaneError("UNAVAILABLE", `${label} is required`);
  try { return JSON.parse(value); } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be valid JSON`);
  }
}

export function readAIGatewayRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): { profiles: readonly ModelProfile[]; policy: ModelRoutePolicy } {
  const profiles = z.array(profileSchema).min(1).parse(
    parseJson(env.GETDONE_AI_MODEL_PROFILES_JSON, "GETDONE_AI_MODEL_PROFILES_JSON")
  ) as ModelProfile[];
  const policy = policySchema.parse(
    parseJson(env.GETDONE_AI_ROUTING_POLICY_JSON, "GETDONE_AI_ROUTING_POLICY_JSON")
  ) as ModelRoutePolicy;
  const ids = new Set(profiles.map((profile) => profile.id));
  for (const route of Object.values(policy.routes)) {
    for (const profileId of route ?? []) {
      if (!ids.has(profileId)) {
        throw new ControlPlaneError(
          "VALIDATION_FAILED",
          `AI routing policy references unknown profile ${profileId}`
        );
      }
    }
  }
  return { profiles: Object.freeze(profiles), policy: Object.freeze(policy) };
}

export async function runOpenRouterCanaryFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const config = readAIGatewayRuntimeConfig(env);
  const environment = parseAuthoritativeRuntimeEnvironment(env.GETDONE_RUNTIME_ENV);
  const adapter = new OpenRouterAIGatewayAdapter(readOpenRouterConfigFromEnv(env));
  const result = await adapter.runCanary();
  if (result.enabled && result.ok) {
    const database = getPostgresRuntimeFromEnv(env).database;
    await new PostgresAIGatewayHealthStore(database).recordSuccessfulCanary({
      environment,
      routingPolicyVersion: config.policy.version,
      observedAt: result.observedAt,
      latencyMs: result.latencyMs
    });
  }
  return result;
}

export function isAIGatewayConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return Boolean(
    env.OPENROUTER_API_KEY?.trim()
    && env.GETDONE_AI_MODEL_PROFILES_JSON?.trim()
    && env.GETDONE_AI_ROUTING_POLICY_JSON?.trim()
  );
}

let installed: AIGateway | null = null;

export function getAIGatewayFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (installed) return installed;
  const config = readAIGatewayRuntimeConfig(env);
  const adapter = new OpenRouterAIGatewayAdapter(readOpenRouterConfigFromEnv(env));
  const database = getPostgresRuntimeFromEnv(env).database;
  installed = new AIGateway(
    config.profiles,
    config.policy,
    adapter,
    new PostgresAICallAuditStore(database)
  );
  return installed;
}

export function resetAIGatewayRuntimeForTests() {
  installed = null;
}
