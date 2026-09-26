import { z } from "zod";
import { createHash } from "node:crypto";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { assertProviderJsonSuccess } from "@/lib/security/provider-response-boundary";
import { validateCapabilityInput } from "@/lib/domain/capabilities";
import {
  createBusinessActionAdapterResult,
  createBusinessActionStatus,
  type AuthorizedBusinessActionRequest,
  type BusinessActionAdapter,
  type BusinessActionExecutionContext,
  type BusinessActionStatus
} from "@/lib/execution/adapters/business-action";
import {
  assertAdapterRequest,
  classifyHttpFailure,
  providerRequestHeaders,
  readBoundedJson,
  requireBrokeredCredential,
  ORDINARY_INTEGRATION_RETRY_TAXONOMY,
  type BusinessActionAdapterDeclaration
} from "@/lib/execution/adapters/ordinary-integration-framework";

export const SLACK_BUSINESS_ACTION_ADAPTER_VERSION = "1.2.0";

const environmentSchema = z.enum(["development", "staging", "production"]);
const slackSuccessSchema = z.object({
  ok: z.literal(true),
  channel: z.string().regex(/^[A-Za-z0-9._@+=-]{1,200}$/),
  ts: z.string().regex(/^\d+\.\d+$/)
}).passthrough();
const slackErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1).max(200)
}).passthrough();
const historySchema = z.object({
  ok: z.literal(true),
  messages: z.array(z.object({
    ts: z.string().regex(/^\d+\.\d+$/)
  }).passthrough()).max(100)
}).passthrough();

export interface SlackProviderConfiguration {
  id: string;
  companyId: string;
  environment: z.infer<typeof environmentSchema>;
  credentialProviderId: string;
  verificationScopes?: readonly string[];
  baseUrl?: string;
  maxResponseBytes?: number;
  verificationMode?: "provider-acceptance-only" | "provider-object-read";
}

export interface SlackBusinessActionAdapterOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

type ValidatedSlackConfiguration = ReturnType<typeof validateConfiguration>;

function validateConfiguration(configuration: SlackProviderConfiguration) {
  if (!/^[A-Za-z0-9._-]+$/.test(configuration.id)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Slack provider configuration id is invalid");
  }
  if (!/^[A-Za-z0-9._:@+-]{1,200}$/.test(configuration.credentialProviderId)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Slack credentialProviderId is invalid");
  }
  const baseUrl = new URL(configuration.baseUrl ?? "https://slack.com/api/");
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.hash) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Slack base URL must be credential-free HTTPS");
  }
  if (
    configuration.environment === "production"
    && configuration.verificationMode === "provider-acceptance-only"
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Slack production actions require provider-object verification"
    );
  }
  const maxResponseBytes = configuration.maxResponseBytes ?? 256_000;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 1_000_000) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Slack maxResponseBytes must be 1-1000000");
  }
  return Object.freeze({
    ...configuration,
    baseUrl: baseUrl.toString().replace(/\/?$/, "/"),
    maxResponseBytes,
    verificationMode: configuration.verificationMode ?? "provider-object-read",
    verificationScopes: Object.freeze([...(configuration.verificationScopes ?? ["channels:history"])])
  });
}

export function deterministicSlackClientMessageId(seed: string) {
  const hex = createHash("sha256").update(seed).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32)
  ].join("-");
}

function classifySlackError(error: string) {
  const retryable = new Set([
    "ratelimited",
    "internal_error",
    "request_timeout",
    "service_unavailable",
    "fatal_error"
  ]);
  return retryable.has(error);
}

function parseProviderOperationId(
  configurations: ReadonlyMap<string, ValidatedSlackConfiguration>,
  providerOperationId: string
) {
  const match = /^slack:([^:]+):([^:]+):(\d+\.\d+)$/.exec(providerOperationId);
  const configuration = match ? configurations.get(match[1]) : undefined;
  if (!match || !configuration) {
    throw new ControlPlaneError("NOT_FOUND", "Slack provider operation is not configured");
  }
  return { configuration, channelId: match[2], messageTs: match[3] };
}

export class SlackBusinessActionAdapter implements BusinessActionAdapter {
  readonly id = "slack-business-action";
  readonly version = SLACK_BUSINESS_ACTION_ADAPTER_VERSION;
  readonly declaration: BusinessActionAdapterDeclaration = Object.freeze({
    capability: "slack.message.send",
    provider: "slack",
    credentialMode: "brokered-lease",
    minimumScopes: Object.freeze(["chat:write"]),
    verificationScopes: Object.freeze(["channels:history or groups:history"]),
    timeoutMs: Object.freeze({ min: 100, max: 120_000 }),
    idempotency: "required",
    retryTaxonomy: ORDINARY_INTEGRATION_RETRY_TAXONOMY,
    providerOperationId: "required",
    statusResume: "supported",
    maxResponseBytes: 1_000_000,
    auditEvidence: "hashed-provider-evidence",
    verificationStrategy: "provider-object-read",
    cancellation: "supported",
    cancellationSemantics: "provider-compensation-not-reversal",
    tenantEnvironmentBinding: true,
    truthSemantics: "provider-acceptance-is-not-business-truth"
  });

  private readonly configurations: ReadonlyMap<string, ValidatedSlackConfiguration>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(
    configurations: readonly SlackProviderConfiguration[],
    options: SlackBusinessActionAdapterOptions = {}
  ) {
    const entries = configurations.map((configuration) => {
      const validated = validateConfiguration(configuration);
      return [validated.id, validated] as const;
    });
    if (entries.length === 0 || new Set(entries.map(([id]) => id)).size !== entries.length) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Slack configurations must be non-empty and unique");
    }
    this.configurations = new Map(entries);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  private configurationFor(request: AuthorizedBusinessActionRequest) {
    const matches = [...this.configurations.values()].filter((configuration) => (
      configuration.companyId === request.scope.companyId
      && configuration.environment === request.scope.environment
    ));
    if (matches.length !== 1) {
      throw new ControlPlaneError(
        "POLICY_BLOCKED",
        "Exactly one Slack provider must be configured for the authoritative tenant/environment"
      );
    }
    return matches[0];
  }

  private requirementFor(configuration: ValidatedSlackConfiguration) {
    return {
      providerId: configuration.credentialProviderId,
      requiredScopes: configuration.verificationMode === "provider-object-read"
        ? ["chat:write", ...configuration.verificationScopes]
        : ["chat:write"]
    };
  }

  credentialRequirement(request: AuthorizedBusinessActionRequest) {
    return this.requirementFor(this.configurationFor(request));
  }

  private credential(
    configuration: ValidatedSlackConfiguration,
    context: BusinessActionExecutionContext | undefined
  ) {
    return requireBrokeredCredential(
      context,
      this.requirementFor(configuration),
      "slack.message.send"
    );
  }

  async execute(
    request: AuthorizedBusinessActionRequest,
    context?: BusinessActionExecutionContext
  ) {
    const configuration = this.configurationFor(request);
    assertAdapterRequest(request, this.declaration, configuration);
    const input = validateCapabilityInput<{
      companyId: string;
      channelId: string;
      text: string;
      threadTs?: string;
    }>("slack.message.send", request.input);
    if (input.companyId !== request.scope.companyId) {
      throw new ControlPlaneError("FORBIDDEN", "Slack company does not match authoritative Job scope");
    }

    const credential = this.credential(configuration, context);
    let response: Response;
    try {
      response = await this.fetchImpl(new URL("chat.postMessage", configuration.baseUrl), {
        method: "POST",
        headers: providerRequestHeaders({
          request,
          credential,
          contentType: "application/json; charset=utf-8"
        }),
        body: JSON.stringify({
          channel: input.channelId,
          text: input.text,
          ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
          client_msg_id: deterministicSlackClientMessageId(request.idempotencyKey)
        }),
        signal: AbortSignal.timeout(request.timeoutMs),
        redirect: "manual"
      });
    } catch {
      return createBusinessActionAdapterResult({
        source: "business-action-adapter",
        requestId: request.id,
        adapterId: this.id,
        adapterVersion: this.version,
        status: "failed",
        retryable: true,
        retryClass: "transport",
        observedAt: this.now().toISOString()
      });
    }

    const observedAt = this.now().toISOString();
    if (!response.ok) {
      await readBoundedJson(response, configuration.maxResponseBytes).catch(() => ({}));
      const failure = classifyHttpFailure(response.status);
      return createBusinessActionAdapterResult({
        source: "business-action-adapter",
        requestId: request.id,
        adapterId: this.id,
        adapterVersion: this.version,
        status: failure.resultStatus,
        retryable: failure.retryable,
        retryClass: failure.retryClass,
        observedAt
      });
    }

    let raw: unknown;
    try {
      raw = await readBoundedJson(response, configuration.maxResponseBytes);
    } catch {
      return createBusinessActionAdapterResult({
        source: "business-action-adapter",
        requestId: request.id,
        adapterId: this.id,
        adapterVersion: this.version,
        status: "failed",
        retryable: false,
        retryClass: "malformed-response",
        observedAt
      });
    }

    const providerError = slackErrorSchema.safeParse(raw);
    if (providerError.success) {
      const retryable = classifySlackError(providerError.data.error);
      return createBusinessActionAdapterResult({
        source: "business-action-adapter",
        requestId: request.id,
        adapterId: this.id,
        adapterVersion: this.version,
        status: retryable ? "failed" : "rejected",
        retryable,
        retryClass: retryable ? "provider-5xx" : "provider-4xx",
        observedAt
      });
    }

    assertProviderJsonSuccess(raw);
    const parsed = slackSuccessSchema.safeParse(raw);
    if (!parsed.success) {
      return createBusinessActionAdapterResult({
        source: "business-action-adapter",
        requestId: request.id,
        adapterId: this.id,
        adapterVersion: this.version,
        status: "failed",
        retryable: false,
        retryClass: "malformed-response",
        observedAt
      });
    }

    const providerOperationId =
      `slack:${configuration.id}:${parsed.data.channel}:${parsed.data.ts}`;
    const output = {
      channelId: parsed.data.channel,
      messageTs: parsed.data.ts,
      providerReference: providerOperationId,
      acceptedAt: observedAt
    };
    return createBusinessActionAdapterResult({
      source: "business-action-adapter",
      requestId: request.id,
      adapterId: this.id,
      adapterVersion: this.version,
      status: configuration.verificationMode === "provider-object-read" ? "accepted" : "completed",
      providerOperationId,
      output,
      retryable: false,
      retryClass: "none",
      observedAt
    });
  }

  async status(
    input: {
      requestId: string;
      providerOperationId: string;
    },
    context?: BusinessActionExecutionContext
  ): Promise<BusinessActionStatus> {
    const { configuration, channelId, messageTs } = parseProviderOperationId(
      this.configurations,
      input.providerOperationId
    );
    if (configuration.verificationMode !== "provider-object-read") {
      throw new ControlPlaneError("UNAVAILABLE", "Slack object verification is not configured");
    }
    const credential = this.credential(configuration, context);
    const url = new URL("conversations.history", configuration.baseUrl);
    url.searchParams.set("channel", channelId);
    url.searchParams.set("latest", messageTs);
    url.searchParams.set("inclusive", "true");
    url.searchParams.set("limit", "1");

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(30_000),
        redirect: "manual"
      });
    } catch {
      return createBusinessActionStatus({
        source: "business-action-adapter",
        requestId: input.requestId,
        providerOperationId: input.providerOperationId,
        adapterId: this.id,
        adapterVersion: this.version,
        state: "running",
        observedAt: this.now().toISOString()
      });
    }

    let state: BusinessActionStatus["state"];
    if (!response.ok) {
      await readBoundedJson(response, configuration.maxResponseBytes).catch(() => ({}));
      state = [408, 425, 429].includes(response.status) || response.status >= 500
        ? "running"
        : "failed";
    } else {
      try {
        const raw = await readBoundedJson(response, configuration.maxResponseBytes);
        const providerError = slackErrorSchema.safeParse(raw);
        if (providerError.success) {
          state = classifySlackError(providerError.data.error) ? "running" : "failed";
        } else {
          assertProviderJsonSuccess(raw);
          const parsed = historySchema.parse(raw);
          state = parsed.messages.some((message) => message.ts === messageTs)
            ? "completed"
            : "running";
        }
      } catch {
        state = "failed";
      }
    }

    return createBusinessActionStatus({
      source: "business-action-adapter",
      requestId: input.requestId,
      providerOperationId: input.providerOperationId,
      adapterId: this.id,
      adapterVersion: this.version,
      state,
      observedAt: this.now().toISOString()
    });
  }

  async cancel(
    input: {
      requestId: string;
      providerOperationId: string;
      reason: string;
    },
    context?: BusinessActionExecutionContext
  ): Promise<BusinessActionStatus> {
    const { configuration, channelId, messageTs } = parseProviderOperationId(
      this.configurations,
      input.providerOperationId
    );
    if (!input.reason.trim()) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Slack cancellation reason is required");
    }
    const credential = this.credential(configuration, context);
    let state: BusinessActionStatus["state"] = "failed";
    try {
      const response = await this.fetchImpl(new URL("chat.delete", configuration.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({ channel: channelId, ts: messageTs }),
        signal: AbortSignal.timeout(30_000),
        redirect: "manual"
      });
      if (response.ok) {
        const raw = await readBoundedJson(response, configuration.maxResponseBytes);
        assertProviderJsonSuccess(raw);
        state = z.object({ ok: z.literal(true) }).passthrough().safeParse(raw).success
          ? "compensated"
          : "failed";
      } else if (response.status >= 500 || response.status === 429) {
        state = "running";
      }
    } catch {
      state = "running";
    }

    return createBusinessActionStatus({
      source: "business-action-adapter",
      requestId: input.requestId,
      providerOperationId: input.providerOperationId,
      adapterId: this.id,
      adapterVersion: this.version,
      state,
      observedAt: this.now().toISOString()
    });
  }
}

export function readSlackProviderConfigurationsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const raw = env.GETDONE_SLACK_ACTIONS_JSON?.trim();
  if (!raw) throw new ControlPlaneError("UNAVAILABLE", "GETDONE_SLACK_ACTIONS_JSON is required");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", "GETDONE_SLACK_ACTIONS_JSON must be valid JSON");
  }
  return z.array(z.object({
    id: z.string().min(1),
    companyId: z.string().min(1),
    environment: environmentSchema,
    credentialProviderId: z.string().min(1),
    verificationScopes: z.array(z.string().min(1)).optional(),
    baseUrl: z.string().url().optional(),
    maxResponseBytes: z.number().int().optional(),
    verificationMode: z.enum(["provider-acceptance-only", "provider-object-read"]).optional()
  }).strict()).min(1).parse(parsed) as readonly SlackProviderConfiguration[];
}
