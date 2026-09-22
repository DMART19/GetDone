import type { ModelProfile, ModelRoutePolicy } from "@/lib/ai-gateway/contracts";

export const AI_GATEWAY_PRODUCTION_CONFIG_VERSION = "2026-09-22.1";
export const OPENROUTER_APPROVED_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_CANARY_MODEL_ID = "openai/gpt-5.6-luna";

export const PRODUCTION_MODEL_PROFILES: readonly ModelProfile[] = Object.freeze([
  Object.freeze({
    id: "openrouter-luna",
    gatewayId: "openrouter",
    providerId: "openrouter",
    modelId: "openai/gpt-5.6-luna",
    enabled: true,
    validationStatus: "validated",
    roles: ["LIGHTWEIGHT", "STANDARD", "VISION", "LONG_CONTEXT"],
    modalities: ["text", "image"],
    supportsTools: true,
    supportsStructuredOutput: true,
    maxContextTokens: 1_050_000,
    allowedDataClasses: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
    allowedEnvironments: ["staging", "production"],
    health: "healthy",
    latencyClass: "low",
    inputCostPerMillionTokensCents: 20,
    outputCostPerMillionTokensCents: 120,
    profileVersion: AI_GATEWAY_PRODUCTION_CONFIG_VERSION
  }),
  Object.freeze({
    id: "openrouter-sol",
    gatewayId: "openrouter",
    providerId: "openrouter",
    modelId: "openai/gpt-5.6-sol",
    enabled: true,
    validationStatus: "validated",
    roles: ["STANDARD", "HIGH_REASONING", "CODING", "VISION", "LONG_CONTEXT"],
    modalities: ["text", "image"],
    supportsTools: true,
    supportsStructuredOutput: true,
    maxContextTokens: 1_050_000,
    allowedDataClasses: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
    allowedEnvironments: ["staging", "production"],
    health: "healthy",
    latencyClass: "standard",
    inputCostPerMillionTokensCents: 200,
    outputCostPerMillionTokensCents: 1_000,
    profileVersion: AI_GATEWAY_PRODUCTION_CONFIG_VERSION
  })
]);

export const PRODUCTION_MODEL_ROUTING_POLICY: ModelRoutePolicy = Object.freeze({
  version: AI_GATEWAY_PRODUCTION_CONFIG_VERSION,
  routes: Object.freeze({
    LIGHTWEIGHT: Object.freeze(["openrouter-luna"]),
    STANDARD: Object.freeze(["openrouter-luna", "openrouter-sol"]),
    HIGH_REASONING: Object.freeze(["openrouter-sol"]),
    CODING: Object.freeze(["openrouter-sol"]),
    VISION: Object.freeze(["openrouter-luna", "openrouter-sol"]),
    LONG_CONTEXT: Object.freeze(["openrouter-luna", "openrouter-sol"])
  })
});
