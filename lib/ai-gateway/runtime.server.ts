import { z } from "zod";
import { AIGateway } from "@/lib/ai-gateway/gateway";
import type { ModelProfile, ModelRoutePolicy } from "@/lib/ai-gateway/contracts";
import {
  AI_GATEWAY_PRODUCTION_CONFIG_VERSION,
  PRODUCTION_MODEL_PROFILES,
  PRODUCTION_MODEL_ROUTING_POLICY
} from "@/lib/ai-gateway/production-config";
import {
  OpenRouterAIGatewayAdapter,
  readOpenRouterConfigFromEnv
} from "@/lib/ai-gateway/openrouter-adapter";
import { ControlPlaneError } from "@/lib/control-plane/errors";
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

function validateConfig(
  profiles: readonly ModelProfile[],
  policy: ModelRoutePolicy,
  requireProductionVersion: boolean
) {
  const ids = new Set(profiles.map((profile) => profile.id));
  if (ids.size !== profiles.length) {
    throw new ControlPlaneError("VALIDATION_FAILED", "AI model profile IDs must be unique");
  }

  if (requireProductionVersion) {
    if (policy.version !== AI_GATEWAY_PRODUCTION_CONFIG_VERSION) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        `AI routing configuration is stale; expected ${AI_GATEWAY_PRODUCTION_CONFIG_VERSION}`
      );
    }
    for (const profile of profiles) {
      if (profile.profileVersion !== AI_GATEWAY_PRODUCTION_CONFIG_VERSION) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          `AI model profile ${profile.id} is stale for routing policy ${policy.version}`
        );
      }
    }
  }

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

  return {
    profiles: Object.freeze([...profiles]),
    policy: Object.freeze(policy)
  };
}

export function readAIGatewayRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): { profiles: readonly ModelProfile[]; policy: ModelRoutePolicy } {
  const runtime = env.GETDONE_RUNTIME_ENV?.trim();
  const authoritative = runtime === "staging" || runtime === "production";
  const hasProfileOverride = Boolean(env.GETDONE_AI_MODEL_PROFILES_JSON?.trim());
  const hasPolicyOverride = Boolean(env.GETDONE_AI_ROUTING_POLICY_JSON?.trim());

  if (authoritative && !hasProfileOverride && !hasPolicyOverride) {
    return validateConfig(
      PRODUCTION_MODEL_PROFILES,
      PRODUCTION_MODEL_ROUTING_POLICY,
      true
    );
  }

  if (hasProfileOverride !== hasPolicyOverride) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "AI profile and routing policy overrides must be supplied together"
    );
  }

  const profiles = z.array(profileSchema).min(1).parse(
    parseJson(env.GETDONE_AI_MODEL_PROFILES_JSON, "GETDONE_AI_MODEL_PROFILES_JSON")
  ) as ModelProfile[];
  const policy = policySchema.parse(
    parseJson(env.GETDONE_AI_ROUTING_POLICY_JSON, "GETDONE_AI_ROUTING_POLICY_JSON")
  ) as ModelRoutePolicy;

  return validateConfig(profiles, policy, authoritative);
}

export function isAIGatewayConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (!env.OPENROUTER_API_KEY?.trim()) return false;
  try {
    readAIGatewayRuntimeConfig(env);
    readOpenRouterConfigFromEnv(env);
    return true;
  } catch {
    return false;
  }
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
