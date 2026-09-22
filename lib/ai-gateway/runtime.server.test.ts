import { describe, expect, it } from "vitest";
import { readAIGatewayRuntimeConfig, isAIGatewayConfigured } from "@/lib/ai-gateway/runtime.server";

const profile = {
  id: "standard",
  gatewayId: "openrouter",
  providerId: "openrouter",
  modelId: "openai/gpt-5.4",
  enabled: true,
  validationStatus: "validated",
  roles: ["STANDARD"],
  modalities: ["text"],
  supportsTools: true,
  supportsStructuredOutput: true,
  maxContextTokens: 128000,
  allowedDataClasses: ["PUBLIC", "INTERNAL"],
  allowedEnvironments: ["staging", "production"],
  health: "healthy",
  latencyClass: "standard",
  inputCostPerMillionTokensCents: 100,
  outputCostPerMillionTokensCents: 200,
  profileVersion: "1.0.0"
};

describe("AI Gateway production runtime configuration", () => {
  it("loads validated model profiles and role routes from server-only configuration", () => {
    const env = {
      OPENROUTER_API_KEY: "server-key",
      GETDONE_AI_MODEL_PROFILES_JSON: JSON.stringify([profile]),
      GETDONE_AI_ROUTING_POLICY_JSON: JSON.stringify({
        version: "1.0.0",
        routes: { STANDARD: ["standard"] }
      })
    };
    expect(isAIGatewayConfigured(env)).toBe(true);
    expect(readAIGatewayRuntimeConfig(env)).toMatchObject({
      profiles: [{ id: "standard", modelId: "openai/gpt-5.4" }],
      policy: { routes: { STANDARD: ["standard"] } }
    });
  });

  it("rejects routing policy references that are not validated profiles", () => {
    expect(() => readAIGatewayRuntimeConfig({
      GETDONE_AI_MODEL_PROFILES_JSON: JSON.stringify([profile]),
      GETDONE_AI_ROUTING_POLICY_JSON: JSON.stringify({
        version: "1.0.0",
        routes: { STANDARD: ["missing"] }
      })
    })).toThrow(/unknown profile/i);
  });
});
