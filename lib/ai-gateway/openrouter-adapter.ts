import type {
  AIGatewayAdapter,
  AIAdapterRequest,
  AIAdapterResponse
} from "@/lib/ai-gateway/contracts";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  assertProviderJsonSuccess,
  readBoundedProviderJson
} from "@/lib/security/provider-response-boundary";

export const OPENROUTER_ADAPTER_VERSION = "1.3.0";
export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

type FetchLike = typeof fetch;
type Sleep = (milliseconds: number) => Promise<void>;

export interface OpenRouterCanaryConfig {
  enabled: boolean;
  modelId?: string;
}

export interface OpenRouterAdapterConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  httpReferer?: string;
  appTitle?: string;
  canary?: OpenRouterCanaryConfig;
}

export interface OpenRouterCredentialMaterial {
  material: string;
  version: number;
}

export interface OpenRouterCredentialProvider {
  current(): Promise<OpenRouterCredentialMaterial>;
}

export interface OpenRouterAdapterOptions {
  fetchImpl?: FetchLike;
  sleep?: Sleep;
  now?: () => Date;
  credentialProvider?: OpenRouterCredentialProvider;
}

interface OpenRouterChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** OpenRouter reports cost in USD when usage accounting is enabled. */
    cost?: number;
  };
}

function requireApiKey(value: string) {
  if (!value.trim()) {
    throw new ControlPlaneError("UNAVAILABLE", "OPENROUTER_API_KEY is required for the live OpenRouter adapter");
  }
  return value.trim();
}

function validateBaseUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new ControlPlaneError("VALIDATION_FAILED", "OpenRouter base URL must use HTTPS");
  }
  if (url.hostname !== "openrouter.ai" && url.hostname !== "eu.openrouter.ai") {
    throw new ControlPlaneError("VALIDATION_FAILED", "OpenRouter base URL must use an approved OpenRouter host");
  }
  return url.toString().replace(/\/$/, "");
}

function normalizeInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string
) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be an integer from ${min} to ${max}`);
  }
  return resolved;
}

function retryableStatus(status: number) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function contentToText(content: unknown) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part
          && typeof part === "object"
          && "text" in part
          && typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

function normalizeInput(input: unknown) {
  if (typeof input === "string") {
    return { messages: [{ role: "user", content: input }] };
  }

  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (Array.isArray(record.messages)) {
      const payload: Record<string, unknown> = { messages: record.messages };
      for (const key of [
        "temperature",
        "top_p",
        "tools",
        "tool_choice",
        "stop",
        "seed",
        "provider",
        "reasoning",
        "user"
      ]) {
        if (record[key] !== undefined) payload[key] = record[key];
      }
      return payload;
    }
    if (typeof record.prompt === "string") {
      return { messages: [{ role: "user", content: record.prompt }] };
    }
  }

  return {
    messages: [{
      role: "user",
      content: typeof input === "undefined" ? "" : JSON.stringify(input)
    }]
  };
}

function retryAfterMs(response: Response) {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 5_000);
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(0, at - Date.now()), 5_000);
}

export function readOpenRouterConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): OpenRouterAdapterConfig {
  const enabled = env.OPENROUTER_CANARY_ENABLED === "true";
  const timeout = env.OPENROUTER_TIMEOUT_MS ? Number(env.OPENROUTER_TIMEOUT_MS) : undefined;
  const retries = env.OPENROUTER_MAX_RETRIES ? Number(env.OPENROUTER_MAX_RETRIES) : undefined;

  if (enabled && !env.OPENROUTER_CANARY_MODEL?.trim()) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "OPENROUTER_CANARY_MODEL is required when OPENROUTER_CANARY_ENABLED=true"
    );
  }

  return {
    apiKey: requireApiKey(env.OPENROUTER_API_KEY ?? ""),
    baseUrl: env.OPENROUTER_BASE_URL ?? OPENROUTER_DEFAULT_BASE_URL,
    timeoutMs: timeout,
    maxRetries: retries,
    httpReferer: env.OPENROUTER_HTTP_REFERER,
    appTitle: env.OPENROUTER_APP_TITLE ?? "GetDone",
    canary: {
      enabled,
      modelId: env.OPENROUTER_CANARY_MODEL
    }
  };
}

export class OpenRouterAIGatewayAdapter implements AIGatewayAdapter {
  readonly id = "openrouter";
  readonly version = OPENROUTER_ADAPTER_VERSION;

  private readonly apiKey: string;
  private readonly credentialProvider?: OpenRouterCredentialProvider;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;
  private readonly now: () => Date;
  private readonly httpReferer?: string;
  private readonly appTitle: string;
  private readonly canary: OpenRouterCanaryConfig;

  constructor(config: OpenRouterAdapterConfig, options: OpenRouterAdapterOptions = {}) {
    this.apiKey = requireApiKey(config.apiKey);
    this.credentialProvider = options.credentialProvider;
    this.baseUrl = validateBaseUrl(config.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL);
    this.timeoutMs = normalizeInteger(config.timeoutMs, 45_000, 1_000, 120_000, "OpenRouter timeout");
    this.maxRetries = normalizeInteger(config.maxRetries, 2, 0, 4, "OpenRouter max retries");
    this.retryBaseDelayMs = normalizeInteger(
      config.retryBaseDelayMs,
      250,
      0,
      5_000,
      "OpenRouter retry base delay"
    );
    this.httpReferer = config.httpReferer;
    this.appTitle = config.appTitle?.trim() || "GetDone";
    this.canary = config.canary ?? { enabled: false };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? (() => new Date());
  }

  private async headers() {
    const credential = this.credentialProvider
      ? await this.credentialProvider.current()
      : { material: this.apiKey, version: 1 };
    if (!credential.material.trim() || !Number.isInteger(credential.version) || credential.version < 1) {
      throw new ControlPlaneError("UNAUTHENTICATED", "OpenRouter credential provider returned invalid material");
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${credential.material}`,
      "content-type": "application/json",
      "x-openrouter-metadata": "enabled",
      "x-title": this.appTitle
    };
    if (this.httpReferer) headers["http-referer"] = this.httpReferer;
    return headers;
  }

  private async request(body: Record<string, unknown>): Promise<OpenRouterChatResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: await this.headers(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: "manual"
        });
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxRetries) break;
        await this.sleep(this.retryBaseDelayMs * 2 ** attempt);
        continue;
      }

      if (response.ok) {
        const parsed = await readBoundedProviderJson(response, 2_000_000, {
          readTimeoutMs: this.timeoutMs
        }) as OpenRouterChatResponse;
        assertProviderJsonSuccess(parsed);
        if (!parsed.model || !Array.isArray(parsed.choices) || parsed.choices.length === 0) {
          throw new ControlPlaneError("UNAVAILABLE", "OpenRouter returned an invalid completion envelope");
        }
        return parsed;
      }

      if (!retryableStatus(response.status) || attempt >= this.maxRetries) {
        throw new ControlPlaneError(
          response.status === 401 || response.status === 403 ? "UNAUTHENTICATED" : "UNAVAILABLE",
          `OpenRouter request failed with HTTP ${response.status}`
        );
      }

      const delay = retryAfterMs(response) ?? this.retryBaseDelayMs * 2 ** attempt;
      await this.sleep(delay);
    }

    throw new ControlPlaneError("UNAVAILABLE", "OpenRouter request timed out or failed after retries", {
      details: { failure: lastError instanceof Error ? lastError.name : "FETCH_FAILURE" }
    });
  }

  async invoke(request: AIAdapterRequest): Promise<AIAdapterResponse> {
    if (request.profile.gatewayId !== this.id || request.profile.providerId !== "openrouter") {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "OpenRouter adapter may only execute profiles bound to gateway/provider=openrouter"
      );
    }

    const startedAt = Date.now();
    const payload = normalizeInput(request.input);
    const response = await this.request({
      ...payload,
      model: request.profile.modelId,
      max_completion_tokens: request.requirements.expectedOutputTokens,
      ...(request.requirements.requiresStructuredOutput
        ? { response_format: { type: "json_object" } }
        : {})
    });

    const content = contentToText(response.choices?.[0]?.message?.content);
    if (!content) {
      throw new ControlPlaneError("UNAVAILABLE", "OpenRouter returned an empty completion");
    }

    let output: unknown = content;
    if (request.requirements.requiresStructuredOutput) {
      try {
        output = JSON.parse(content);
      } catch {
        output = content;
      }
    }

    return {
      profileId: request.profile.id,
      gatewayId: this.id,
      providerId: "openrouter",
      modelId: response.model!,
      output,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      providerCostCents: typeof response.usage?.cost === "number"
        && Number.isFinite(response.usage.cost)
        && response.usage.cost >= 0
        ? Number((response.usage.cost * 100).toFixed(6))
        : undefined,
      latencyMs: Math.max(0, Date.now() - startedAt),
      observedAt: this.now().toISOString()
    };
  }

  async runCanary() {
    if (!this.canary.enabled) {
      return { enabled: false as const, ok: false as const, reason: "CANARY_DISABLED" as const };
    }
    const modelId = this.canary.modelId?.trim();
    if (!modelId) {
      throw new ControlPlaneError("VALIDATION_FAILED", "OpenRouter canary model is required");
    }
    if (modelId === "openrouter/auto" || modelId.startsWith("~")) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "OpenRouter canary must use a concrete model ID so identity can be verified"
      );
    }

    const startedAt = Date.now();
    const response = await this.request({
      model: modelId,
      messages: [{ role: "user", content: "Reply with exactly: GETDONE_CANARY_OK" }],
      max_completion_tokens: 16,
      temperature: 0
    });
    const content = contentToText(response.choices?.[0]?.message?.content).trim();

    if (response.model !== modelId) {
      throw new ControlPlaneError("UNAVAILABLE", "OpenRouter canary model identity mismatch");
    }
    if (content !== "GETDONE_CANARY_OK") {
      throw new ControlPlaneError("UNAVAILABLE", "OpenRouter canary response validation failed");
    }

    return {
      enabled: true as const,
      ok: true as const,
      modelId,
      latencyMs: Math.max(0, Date.now() - startedAt),
      observedAt: this.now().toISOString()
    };
  }
}
