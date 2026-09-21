import { describe, expect, it } from "vitest";
import {
  OpenRouterAIGatewayAdapter,
  readOpenRouterConfigFromEnv
} from "@/lib/ai-gateway/openrouter-adapter";
import type { AIAdapterRequest, ModelProfile } from "@/lib/ai-gateway/contracts";

const profile: ModelProfile = {
  id: "openrouter-standard",
  gatewayId: "openrouter",
  providerId: "openrouter",
  modelId: "openai/gpt-5.4",
  enabled: true,
  validationStatus: "validated",
  roles: ["STANDARD"],
  modalities: ["text"],
  supportsTools: true,
  supportsStructuredOutput: true,
  maxContextTokens: 100_000,
  allowedDataClasses: ["public", "internal"],
  allowedEnvironments: ["development"],
  health: "healthy",
  latencyClass: "standard",
  inputCostPerMillionTokensCents: 100,
  outputCostPerMillionTokensCents: 200,
  profileVersion: "1.0.0"
};

function adapterRequest(input: unknown, structured = false): AIAdapterRequest {
  return {
    requestId: "request-1",
    correlationId: "correlation-1",
    profile,
    input,
    requirements: {
      role: "STANDARD",
      requiredModalities: ["text"],
      requiresTools: false,
      requiresStructuredOutput: structured,
      minimumContextTokens: 1_000,
      estimatedInputTokens: 100,
      expectedOutputTokens: 50,
      dataClass: "public",
      environment: "development",
      latencyClass: "standard",
      maxCostCents: 10,
      allowFallback: false
    }
  };
}

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

describe("OpenRouterAIGatewayAdapter", () => {
  it("normalizes a successful completion and preserves actual model identity", async () => {
    let captured: RequestInit | undefined;
    const adapter = new OpenRouterAIGatewayAdapter(
      { apiKey: "test-key", maxRetries: 0 },
      {
        fetchImpl: async (_url, init) => {
          captured = init;
          return response({
            id: "gen-1",
            model: "openai/gpt-5.4",
            choices: [{ message: { content: "hello" } }],
            usage: { prompt_tokens: 12, completion_tokens: 3 }
          });
        },
        now: () => new Date("2026-09-21T04:00:00Z")
      }
    );

    const result = await adapter.invoke(adapterRequest("hello"));
    expect(result).toMatchObject({
      profileId: profile.id,
      gatewayId: "openrouter",
      providerId: "openrouter",
      modelId: "openai/gpt-5.4",
      output: "hello",
      inputTokens: 12,
      outputTokens: 3,
      observedAt: "2026-09-21T04:00:00.000Z"
    });
    const headers = captured?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers["x-openrouter-metadata"]).toBe("enabled");
  });

  it("parses structured JSON content for gateway schema validation", async () => {
    const adapter = new OpenRouterAIGatewayAdapter(
      { apiKey: "test-key", maxRetries: 0 },
      {
        fetchImpl: async () => response({
          model: "openai/gpt-5.4",
          choices: [{ message: { content: "{\"answer\":\"ok\"}" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 }
        })
      }
    );
    const result = await adapter.invoke(adapterRequest({ prompt: "x" }, true));
    expect(result.output).toEqual({ answer: "ok" });
  });

  it("retries retryable responses and honors retry-after", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const adapter = new OpenRouterAIGatewayAdapter(
      { apiKey: "test-key", maxRetries: 2, retryBaseDelayMs: 10 },
      {
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) return response({ error: "rate" }, 429, { "retry-after": "1" });
          return response({
            model: "openai/gpt-5.4",
            choices: [{ message: { content: "ok" } }]
          });
        },
        sleep: async (ms) => { sleeps.push(ms); }
      }
    );
    await expect(adapter.invoke(adapterRequest("x"))).resolves.toMatchObject({ output: "ok" });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  it("does not retry authentication failures", async () => {
    let calls = 0;
    const adapter = new OpenRouterAIGatewayAdapter(
      { apiKey: "test-key", maxRetries: 3 },
      {
        fetchImpl: async () => {
          calls += 1;
          return response({ error: "bad key" }, 401);
        },
        sleep: async () => undefined
      }
    );
    await expect(adapter.invoke(adapterRequest("x"))).rejects.toThrow(/HTTP 401/);
    expect(calls).toBe(1);
  });

  it("retries transport failures including timeout-style exceptions", async () => {
    let calls = 0;
    const adapter = new OpenRouterAIGatewayAdapter(
      { apiKey: "test-key", maxRetries: 1, retryBaseDelayMs: 0 },
      {
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) throw new DOMException("timed out", "TimeoutError");
          return response({
            model: "openai/gpt-5.4",
            choices: [{ message: { content: "recovered" } }]
          });
        },
        sleep: async () => undefined
      }
    );
    await expect(adapter.invoke(adapterRequest("x"))).resolves.toMatchObject({ output: "recovered" });
    expect(calls).toBe(2);
  });

  it("returns the actual response model so the gateway can reject identity drift", async () => {
    const adapter = new OpenRouterAIGatewayAdapter(
      { apiKey: "test-key", maxRetries: 0 },
      {
        fetchImpl: async () => response({
          model: "unexpected/provider-model",
          choices: [{ message: { content: "x" } }]
        })
      }
    );
    const result = await adapter.invoke(adapterRequest("x"));
    expect(result.modelId).toBe("unexpected/provider-model");
  });

  it("validates canary configuration without requiring a live key in tests", () => {
    expect(() => readOpenRouterConfigFromEnv({
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_CANARY_ENABLED: "true"
    })).toThrow(/CANARY_MODEL/);
  });

  it("runs a concrete-model canary and rejects model identity drift", async () => {
    const adapter = new OpenRouterAIGatewayAdapter(
      {
        apiKey: "test-key",
        maxRetries: 0,
        canary: { enabled: true, modelId: "openai/gpt-5.4" }
      },
      {
        fetchImpl: async () => response({
          model: "openai/gpt-5.4",
          choices: [{ message: { content: "GETDONE_CANARY_OK" } }]
        }),
        now: () => new Date("2026-09-21T04:00:00Z")
      }
    );
    await expect(adapter.runCanary()).resolves.toMatchObject({
      enabled: true,
      ok: true,
      modelId: "openai/gpt-5.4"
    });

    const mismatch = new OpenRouterAIGatewayAdapter(
      {
        apiKey: "test-key",
        maxRetries: 0,
        canary: { enabled: true, modelId: "openai/gpt-5.4" }
      },
      {
        fetchImpl: async () => response({
          model: "openai/other",
          choices: [{ message: { content: "GETDONE_CANARY_OK" } }]
        })
      }
    );
    await expect(mismatch.runCanary()).rejects.toThrow(/identity mismatch/i);
  });
});
