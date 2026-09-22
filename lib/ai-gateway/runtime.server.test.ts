import { describe, expect, it } from "vitest";
import {
  readAIGatewayRuntimeConfig,
  isAIGatewayConfigured
} from "@/lib/ai-gateway/runtime.server";
import {
  AI_GATEWAY_PRODUCTION_CONFIG_VERSION
} from "@/lib/ai-gateway/production-config";

const developmentProfile = {
  id: "standard",
  gatewayId: "openrouter",
  providerId: "openrouter",
  modelId: "openai/gpt-5.6-luna",
  enabled: true,
  validationStatus: "validated",
  roles: ["STANDARD"],
  modalities: ["text"],
  supportsTools: true,
  supportsStructuredOutput: true,
  maxContextTokens: 128000,
  allowedDataClasses: ["PUBLIC", "INTERNAL"],
  allowedEnvironments: ["development"],
  health: "healthy",
  latencyClass: "standard",
  inputCostPerMillionTokensCents: 20,
  outputCostPerMillionTokensCents: 120,
  profileVersion: "dev-1"
};

describe("AI Gateway production runtime configuration", () => {
  it("uses the versioned production OpenRouter profiles and route policy by default", () => {
    const env = {
      GETDONE_RUNTIME_ENV: "production",
      OPENROUTER_API_KEY: "server-key"
    };
    expect(isAIGatewayConfigured(env)).toBe(true);
    expect(readAIGatewayRuntimeConfig(env)).toMatchObject({
      profiles: [
        { id: "openrouter-luna", modelId: "openai/gpt-5.6-luna" },
        { id: "openrouter-sol", modelId: "openai/gpt-5.6-sol" }
      ],
      policy: {
        version: AI_GATEWAY_PRODUCTION_CONFIG_VERSION,
        routes: {
          STANDARD: ["openrouter-luna", "openrouter-sol"],
          HIGH_REASONING: ["openrouter-sol"],
          CODING: ["openrouter-sol"]
        }
      }
    });
  });

  it("still permits explicit development-only profile/routing configuration", () => {
    const env = {
      GETDONE_RUNTIME_ENV: "development",
      OPENROUTER_API_KEY: "server-key",
      GETDONE_AI_MODEL_PROFILES_JSON: JSON.stringify([developmentProfile]),
      GETDONE_AI_ROUTING_POLICY_JSON: JSON.stringify({
        version: "dev-1",
        routes: { STANDARD: ["standard"] }
      })
    };
    expect(isAIGatewayConfigured(env)).toBe(true);
    expect(readAIGatewayRuntimeConfig(env)).toMatchObject({
      profiles: [{ id: "standard", modelId: "openai/gpt-5.6-luna" }],
      policy: { version: "dev-1", routes: { STANDARD: ["standard"] } }
    });
  });

  it("rejects stale production routing/profile overrides", () => {
    const stale = {
      ...developmentProfile,
      allowedEnvironments: ["production"],
      profileVersion: "old"
    };
    expect(() => readAIGatewayRuntimeConfig({
      GETDONE_RUNTIME_ENV: "production",
      GETDONE_AI_MODEL_PROFILES_JSON: JSON.stringify([stale]),
      GETDONE_AI_ROUTING_POLICY_JSON: JSON.stringify({
        version: "old",
        routes: { STANDARD: ["standard"] }
      })
    })).toThrow(/stale/i);
  });

  it("rejects partial overrides and unknown route profile references", () => {
    expect(() => readAIGatewayRuntimeConfig({
      GETDONE_RUNTIME_ENV: "development",
      GETDONE_AI_MODEL_PROFILES_JSON: JSON.stringify([developmentProfile])
    })).toThrow(/supplied together/i);

    expect(() => readAIGatewayRuntimeConfig({
      GETDONE_RUNTIME_ENV: "development",
      GETDONE_AI_MODEL_PROFILES_JSON: JSON.stringify([developmentProfile]),
      GETDONE_AI_ROUTING_POLICY_JSON: JSON.stringify({
        version: "dev-1",
        routes: { STANDARD: ["missing"] }
      })
    })).toThrow(/unknown profile/i);
  });
});
