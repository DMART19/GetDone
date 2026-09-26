import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  ConfiguredHttpActionAdapter
} from "@/lib/execution/adapters/configured-http-action";
import {
  ConfiguredWebhookActionAdapter
} from "@/lib/execution/adapters/configured-webhook-action";
import {
  GmailBusinessActionAdapter
} from "@/lib/execution/adapters/gmail-action";
import {
  SlackBusinessActionAdapter
} from "@/lib/execution/adapters/slack-action";
import type {
  AuthorizedBusinessActionRequest,
  BusinessActionExecutionContext
} from "@/lib/execution/adapters/business-action";
import {
  OpenRouterAIGatewayAdapter
} from "@/lib/ai-gateway/openrouter-adapter";
import type {
  AIAdapterRequest,
  ModelProfile
} from "@/lib/ai-gateway/contracts";

type AdapterKind = "http" | "webhook" | "gmail" | "slack" | "openrouter";
type HostileVector =
  | "malformed-json"
  | "huge-string"
  | "nested-payload"
  | "strange-unicode"
  | "invalid-content-type"
  | "conflicting-ids"
  | "false-success"
  | "redirect"
  | "slow-stream"
  | "truncated-stream";

const adapterKinds: readonly AdapterKind[] = [
  "http",
  "webhook",
  "gmail",
  "slack",
  "openrouter"
];

const hostileVectors: readonly HostileVector[] = [
  "malformed-json",
  "huge-string",
  "nested-payload",
  "strange-unicode",
  "invalid-content-type",
  "conflicting-ids",
  "false-success",
  "redirect",
  "slow-stream",
  "truncated-stream"
];

afterEach(() => {
  vi.useRealTimers();
});

function deeplyNested() {
  let value: unknown = "leaf";
  for (let index = 0; index < 70; index += 1) {
    value = { child: value };
  }
  return value;
}

function normalEnvelope(kind: AdapterKind): Record<string, unknown> {
  switch (kind) {
    case "http":
    case "webhook":
      return { success: true };
    case "gmail":
      return { id: "message-1" };
    case "slack":
      return { ok: true, channel: "C123", ts: "123.456" };
    case "openrouter":
      return {
        id: "gen-1",
        model: "openai/gpt-5.4",
        choices: [{ message: { content: "ok" } }]
      };
  }
}

function hostileResponse(kind: AdapterKind, vector: HostileVector) {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };
  if (kind === "http" || kind === "webhook") {
    headers["x-provider-operation-id"] = "provider-op-1";
  }

  if (vector === "redirect") {
    return new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" }
    });
  }

  if (vector === "slow-stream") {
    return new Response(new ReadableStream<Uint8Array>({ pull() {} }), {
      status: 200,
      headers
    });
  }

  if (vector === "truncated-stream") {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        controller.error(new Error("connection reset"));
      }
    });
    return new Response(stream, { status: 200, headers });
  }

  if (vector === "malformed-json") {
    return new Response("{malformed", { status: 200, headers });
  }

  if (vector === "invalid-content-type") {
    return new Response(JSON.stringify(normalEnvelope(kind)), {
      status: 200,
      headers: {
        ...headers,
        "content-type": "application/octet-stream"
      }
    });
  }

  if (vector === "huge-string") {
    if (kind === "openrouter") {
      const envelope = normalEnvelope(kind);
      (envelope.choices as Array<{ message: { content: string } }>)[0].message.content =
        "x".repeat(1_000_100);
      return new Response(JSON.stringify(envelope), { status: 200, headers });
    }
    const envelope = normalEnvelope(kind);
    envelope.padding = "x".repeat(1_024);
    return new Response(JSON.stringify(envelope), { status: 200, headers });
  }

  const envelope = normalEnvelope(kind);

  if (vector === "nested-payload") {
    envelope.meta = deeplyNested();
  }

  if (vector === "strange-unicode") {
    const hostileIdentifier = "id-\u202e\u2066e\u0301😀";
    if (kind === "http" || kind === "webhook") {
      headers["x-provider-operation-id"] = hostileIdentifier;
    } else if (kind === "gmail") {
      envelope.id = hostileIdentifier;
    } else if (kind === "slack") {
      envelope.channel = hostileIdentifier;
    } else {
      envelope.model = "openai/\u202e\u2066gpt😀";
    }
  }

  if (vector === "conflicting-ids") {
    if (kind === "http" || kind === "webhook") {
      envelope.id = "provider-op-2";
    } else if (kind === "gmail") {
      envelope.id = "message-1";
      envelope.operationId = "message-2";
    } else if (kind === "slack") {
      envelope.id = "slack-op-1";
      envelope.operationId = "slack-op-2";
    } else {
      envelope.operationId = "gen-2";
    }
  }

  if (vector === "false-success") {
    if (kind === "slack") {
      envelope.success = false;
    } else {
      envelope.success = false;
    }
  }

  return new Response(JSON.stringify(envelope), { status: 200, headers });
}

function businessRequest(
  capability: string,
  input: unknown,
  id: string
): AuthorizedBusinessActionRequest {
  return {
    id,
    jobId: `job-${id}`,
    scope: {
      userId: "owner",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "development"
    },
    capability,
    input,
    inputHash: sha256Hex(input),
    authorizationConsumptionHash: sha256Hex({ id, authority: "test" }),
    idempotencyKey: `idem-${id}`,
    timeoutMs: 5_000,
    attempt: 1
  };
}

function credentialContext(
  capability: string,
  providerId: string,
  scopes: readonly string[]
): BusinessActionExecutionContext {
  return {
    credential: {
      leaseId: `lease-${providerId}`,
      leaseHash: sha256Hex({ providerId, capability }),
      providerId,
      capability,
      grantedScopes: [...scopes],
      material: "fixture-secret",
      issuedAt: "2026-09-26T15:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z"
    }
  };
}

const openRouterProfile: ModelProfile = {
  id: "openrouter-fuzz",
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
  allowedDataClasses: ["PUBLIC", "INTERNAL"],
  allowedEnvironments: ["development"],
  health: "healthy",
  latencyClass: "standard",
  inputCostPerMillionTokensCents: 1,
  outputCostPerMillionTokensCents: 1,
  profileVersion: "1.0.0"
};

function openRouterRequest(): AIAdapterRequest {
  return {
    requestId: "openrouter-fuzz-request",
    correlationId: "openrouter-fuzz-correlation",
    profile: openRouterProfile,
    input: "test",
    requirements: {
      role: "STANDARD",
      requiredModalities: ["text"],
      requiresTools: false,
      requiresStructuredOutput: false,
      minimumContextTokens: 1_000,
      estimatedInputTokens: 10,
      expectedOutputTokens: 10,
      dataClass: "PUBLIC",
      environment: "development",
      latencyClass: "standard",
      maxCostCents: 10,
      allowFallback: false
    }
  };
}

async function adapterBlocked(kind: AdapterKind, response: Response) {
  try {
    if (kind === "http") {
      const input = {
        companyId: "company-a",
        operation: "sync",
        payload: { id: "record-1" }
      };
      const adapter = new ConfiguredHttpActionAdapter([{
        name: "sync",
        companyId: "company-a",
        environment: "development",
        url: "https://api.example.test/sync",
        maxResponseBytes: 256
      }], {
        fetchImpl: async () => response
      });
      const result = await adapter.execute(businessRequest("http.request", input, "http-fuzz"));
      return result.status !== "completed" && result.status !== "accepted";
    }

    if (kind === "webhook") {
      const input = {
        companyId: "company-a",
        operation: "notify",
        payload: { id: "event-1" }
      };
      const adapter = new ConfiguredWebhookActionAdapter([{
        name: "notify",
        companyId: "company-a",
        environment: "development",
        url: "https://hooks.example.test/notify",
        maxResponseBytes: 256
      }], {
        fetchImpl: async () => response
      });
      const result = await adapter.execute(businessRequest("webhook.send", input, "webhook-fuzz"));
      return result.status !== "completed" && result.status !== "accepted";
    }

    if (kind === "gmail") {
      const input = {
        companyId: "company-a",
        to: ["owner@example.test"],
        cc: [],
        subject: "Fuzz",
        text: "test"
      };
      const adapter = new GmailBusinessActionAdapter([{
        id: "gmail-fuzz",
        companyId: "company-a",
        environment: "development",
        credentialProviderId: "gmail-provider",
        baseUrl: "https://gmail.example.test/",
        maxResponseBytes: 256,
        verificationMode: "provider-acceptance-only"
      }], {
        fetchImpl: async () => response
      });
      const result = await adapter.execute(
        businessRequest("email.send", input, "gmail-fuzz"),
        credentialContext(
          "email.send",
          "gmail-provider",
          ["https://www.googleapis.com/auth/gmail.send"]
        )
      );
      return result.status !== "completed" && result.status !== "accepted";
    }

    if (kind === "slack") {
      const input = {
        companyId: "company-a",
        channelId: "C123",
        text: "fuzz"
      };
      const adapter = new SlackBusinessActionAdapter([{
        id: "slack-fuzz",
        companyId: "company-a",
        environment: "development",
        credentialProviderId: "slack-provider",
        baseUrl: "https://slack.example.test/api/",
        maxResponseBytes: 256,
        verificationMode: "provider-acceptance-only"
      }], {
        fetchImpl: async () => response
      });
      const result = await adapter.execute(
        businessRequest("slack.message.send", input, "slack-fuzz"),
        credentialContext("slack.message.send", "slack-provider", ["chat:write"])
      );
      return result.status !== "completed" && result.status !== "accepted";
    }

    const adapter = new OpenRouterAIGatewayAdapter({
      apiKey: "test-key",
      maxRetries: 0,
      timeoutMs: 1_000
    }, {
      fetchImpl: async () => response
    });
    await adapter.invoke(openRouterRequest());
    return false;
  } catch {
    return true;
  }
}

describe("requirement 42 hostile provider adapter matrix", () => {
  const cases = adapterKinds.flatMap((adapter) =>
    hostileVectors.map((vector) => ({ adapter, vector }))
  );

  it.each(cases)(
    "$adapter blocks $vector",
    async ({ adapter, vector }) => {
      if (vector === "slow-stream") {
        vi.useFakeTimers();
        const pending = adapterBlocked(adapter, hostileResponse(adapter, vector));
        await vi.advanceTimersByTimeAsync(31_000);
        await expect(pending).resolves.toBe(true);
        return;
      }

      await expect(
        adapterBlocked(adapter, hostileResponse(adapter, vector))
      ).resolves.toBe(true);
    }
  );
});
