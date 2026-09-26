import { z } from "zod";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
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
  assertProviderOperationId,
  classifyHttpFailure,
  providerRequestHeaders,
  readBoundedJson,
  requireBrokeredCredential,
  ORDINARY_INTEGRATION_RETRY_TAXONOMY,
  type BusinessActionAdapterDeclaration
} from "@/lib/execution/adapters/ordinary-integration-framework";

export const GMAIL_BUSINESS_ACTION_ADAPTER_VERSION = "1.3.0";

const gmailSendResponseSchema = z.object({
  id: z.string().min(1).max(500),
  threadId: z.string().min(1).max(500).optional()
}).passthrough();

const gmailGetResponseSchema = z.object({
  id: z.string().min(1).max(500)
}).passthrough();

const gmailListResponseSchema = z.object({
  messages: z.array(z.object({
    id: z.string().min(1).max(500)
  }).passthrough()).optional()
}).passthrough();

const environmentSchema = z.enum(["development", "staging", "production"]);

export interface GmailProviderConfiguration {
  id: string;
  companyId: string;
  environment: z.infer<typeof environmentSchema>;
  credentialProviderId: string;
  userId?: string;
  baseUrl?: string;
  maxResponseBytes?: number;
  verificationMode?: "provider-acceptance-only" | "provider-object-read";
}

export interface GmailBusinessActionAdapterOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

type ValidatedGmailConfiguration = ReturnType<typeof validateConfiguration>;

type GmailLookupResult =
  | { kind: "found"; messageId: string }
  | { kind: "not-found" }
  | { kind: "retryable"; retryClass: "transport" | "rate-limit" | "provider-5xx" }
  | { kind: "terminal"; retryClass: "provider-4xx" }
  | { kind: "malformed"; retryClass: "malformed-response" };

function validateConfiguration(configuration: GmailProviderConfiguration) {
  if (!/^[A-Za-z0-9._-]+$/.test(configuration.id)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Gmail provider configuration id is invalid");
  }
  if (!/^[A-Za-z0-9._:@+-]{1,200}$/.test(configuration.credentialProviderId)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Gmail credentialProviderId is invalid");
  }
  const baseUrl = new URL(configuration.baseUrl ?? "https://gmail.googleapis.com/gmail/v1/");
  if (
    baseUrl.protocol !== "https:"
    || baseUrl.username
    || baseUrl.password
    || baseUrl.hash
  ) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Gmail base URL must be credential-free HTTPS");
  }
  if (
    configuration.environment === "production"
    && configuration.verificationMode === "provider-acceptance-only"
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Gmail production actions require provider-object verification"
    );
  }
  const maxResponseBytes = configuration.maxResponseBytes ?? 256_000;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 1_000_000) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Gmail maxResponseBytes must be 1-1000000");
  }
  return Object.freeze({
    ...configuration,
    userId: configuration.userId ?? "me",
    baseUrl: baseUrl.toString().replace(/\/?$/, "/"),
    maxResponseBytes,
    verificationMode: configuration.verificationMode ?? "provider-object-read"
  });
}

function rejectHeaderInjection(value: string | undefined, label: string) {
  if (value && /[\r\n]/.test(value)) {
    throw new ControlPlaneError("VALIDATION_FAILED", label + " cannot contain CR/LF");
  }
}

function encodeSubject(subject: string) {
  rejectHeaderInjection(subject, "Email subject");
  return "=?UTF-8?B?" + Buffer.from(subject, "utf8").toString("base64") + "?=";
}

export function gmailRfc822MessageId(requestId: string) {
  if (!requestId.trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Gmail request id is required");
  }
  return "getdone-" + sha256Hex({ provider: "gmail", requestId }).slice(0, 48) + "@getdone.invalid";
}

function buildMime(input: {
  to: string[];
  cc: string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
}, requestId: string) {
  rejectHeaderInjection(input.replyTo, "Email replyTo");
  const messageId = gmailRfc822MessageId(requestId);
  const headers = [
    "To: " + input.to.join(", "),
    ...(input.cc.length ? ["Cc: " + input.cc.join(", ")] : []),
    "Subject: " + encodeSubject(input.subject),
    "Message-ID: <" + messageId + ">",
    ...(input.replyTo ? ["Reply-To: " + input.replyTo] : []),
    "MIME-Version: 1.0"
  ];

  let body: string;
  if (input.text !== undefined && input.html !== undefined) {
    const boundary = "getdone-" + Buffer.from(requestId).toString("base64url").slice(0, 32);
    headers.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
    body = [
      "--" + boundary,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      input.text,
      "--" + boundary,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      input.html,
      "--" + boundary + "--"
    ].join("\r\n");
  } else if (input.html !== undefined) {
    headers.push('Content-Type: text/html; charset="UTF-8"');
    headers.push("Content-Transfer-Encoding: 8bit");
    body = input.html;
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push("Content-Transfer-Encoding: 8bit");
    body = input.text ?? "";
  }
  return Buffer.from([...headers, "", body].join("\r\n"), "utf8").toString("base64url");
}

function syntheticProviderOperationId(configurationId: string, messageId: string) {
  return "gmail:" + configurationId + ":rfc822:" + Buffer.from(messageId, "utf8").toString("base64url");
}

function parseProviderOperationId(
  configurations: ReadonlyMap<string, ValidatedGmailConfiguration>,
  providerOperationId: string
) {
  const match = /^gmail:([^:]+):(.+)$/.exec(providerOperationId);
  const configuration = match ? configurations.get(match[1]) : undefined;
  if (!match || !configuration) {
    throw new ControlPlaneError("NOT_FOUND", "Gmail provider operation is not configured");
  }
  const value = match[2];
  if (value.startsWith("rfc822:")) {
    let rfc822MessageId = "";
    try {
      rfc822MessageId = Buffer.from(value.slice("rfc822:".length), "base64url").toString("utf8");
    } catch {
      throw new ControlPlaneError("VALIDATION_FAILED", "Gmail provider operation lineage is malformed");
    }
    if (!/^[A-Za-z0-9._@-]+$/.test(rfc822MessageId)) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Gmail RFC822 provider lineage is malformed");
    }
    return { configuration, kind: "rfc822" as const, value: rfc822MessageId };
  }
  return { configuration, kind: "message" as const, value: assertProviderOperationId(value) };
}

export class GmailBusinessActionAdapter implements BusinessActionAdapter {
  readonly id = "gmail-business-action";
  readonly version = GMAIL_BUSINESS_ACTION_ADAPTER_VERSION;
  readonly declaration: BusinessActionAdapterDeclaration = Object.freeze({
    capability: "email.send",
    provider: "gmail",
    credentialMode: "brokered-lease",
    minimumScopes: Object.freeze(["https://www.googleapis.com/auth/gmail.send"]),
    verificationScopes: Object.freeze(["https://www.googleapis.com/auth/gmail.readonly"]),
    timeoutMs: Object.freeze({ min: 100, max: 120_000 }),
    idempotency: "required",
    retryTaxonomy: ORDINARY_INTEGRATION_RETRY_TAXONOMY,
    providerOperationId: "required",
    statusResume: "supported",
    maxResponseBytes: 1_000_000,
    auditEvidence: "hashed-provider-evidence",
    verificationStrategy: "provider-object-read",
    cancellation: "not-supported",
    cancellationSemantics: "local-stop-only-after-dispatch",
    tenantEnvironmentBinding: true,
    truthSemantics: "provider-acceptance-is-not-business-truth"
  });

  private readonly configurations: ReadonlyMap<string, ValidatedGmailConfiguration>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(
    configurations: readonly GmailProviderConfiguration[],
    options: GmailBusinessActionAdapterOptions = {}
  ) {
    const entries = configurations.map((configuration) => {
      const validated = validateConfiguration(configuration);
      return [validated.id, validated] as const;
    });
    if (entries.length === 0 || new Set(entries.map(([id]) => id)).size !== entries.length) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Gmail configurations must be non-empty and unique");
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
        "Exactly one Gmail provider must be configured for the authoritative tenant/environment"
      );
    }
    return matches[0];
  }

  private requirementFor(configuration: ValidatedGmailConfiguration) {
    return {
      providerId: configuration.credentialProviderId,
      requiredScopes: configuration.verificationMode === "provider-object-read"
        ? [
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/gmail.readonly"
          ]
        : ["https://www.googleapis.com/auth/gmail.send"]
    };
  }

  credentialRequirement(request: AuthorizedBusinessActionRequest) {
    return this.requirementFor(this.configurationFor(request));
  }

  private credential(
    configuration: ValidatedGmailConfiguration,
    context: BusinessActionExecutionContext | undefined
  ) {
    return requireBrokeredCredential(context, this.requirementFor(configuration), "email.send");
  }

  private async lookupByRfc822MessageId(
    configuration: ValidatedGmailConfiguration,
    rfc822MessageId: string,
    credential: string
  ): Promise<GmailLookupResult> {
    let response: Response;
    try {
      const url = new URL(
        "users/" + encodeURIComponent(configuration.userId) + "/messages",
        configuration.baseUrl
      );
      url.searchParams.set("q", "rfc822msgid:" + rfc822MessageId);
      url.searchParams.set("maxResults", "2");
      url.searchParams.set("includeSpamTrash", "true");
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: "Bearer " + credential },
        signal: AbortSignal.timeout(30_000),
        redirect: "manual"
      });
    } catch {
      return { kind: "retryable", retryClass: "transport" };
    }

    if (!response.ok) {
      await readBoundedJson(response, configuration.maxResponseBytes).catch(() => ({}));
      const failure = classifyHttpFailure(response.status);
      if (failure.retryable) {
        return {
          kind: "retryable",
          retryClass: failure.retryClass === "rate-limit" ? "rate-limit" : "provider-5xx"
        };
      }
      return { kind: "terminal", retryClass: "provider-4xx" };
    }

    try {
      const raw = await readBoundedJson(response, configuration.maxResponseBytes);
      assertProviderJsonSuccess(raw);
      const parsed = gmailListResponseSchema.parse(raw);
      const message = parsed.messages?.[0];
      return message ? { kind: "found", messageId: message.id } : { kind: "not-found" };
    } catch {
      return { kind: "malformed", retryClass: "malformed-response" };
    }
  }

  private acceptedFromLookup(
    request: AuthorizedBusinessActionRequest,
    configuration: ValidatedGmailConfiguration,
    messageId: string,
    recipients: readonly string[],
    observedAt: string
  ) {
    const safeMessageId = assertProviderOperationId(messageId);
    const providerOperationId = "gmail:" + configuration.id + ":" + safeMessageId;
    return createBusinessActionAdapterResult({
      source: "business-action-adapter",
      requestId: request.id,
      adapterId: this.id,
      adapterVersion: this.version,
      status: "accepted",
      providerOperationId,
      output: {
        messageId: safeMessageId,
        providerReference: providerOperationId,
        accepted: [...recipients],
        rejected: [],
        acceptedAt: observedAt
      },
      retryable: false,
      retryClass: "none",
      observedAt
    });
  }

  private ambiguousAcceptance(
    request: AuthorizedBusinessActionRequest,
    configuration: ValidatedGmailConfiguration,
    rfc822MessageId: string,
    retryClass: "transport" | "malformed-response"
  ) {
    return createBusinessActionAdapterResult({
      source: "business-action-adapter",
      requestId: request.id,
      adapterId: this.id,
      adapterVersion: this.version,
      status: "accepted",
      providerOperationId: syntheticProviderOperationId(configuration.id, rfc822MessageId),
      retryable: true,
      retryClass,
      observedAt: this.now().toISOString()
    });
  }

  async execute(
    request: AuthorizedBusinessActionRequest,
    context?: BusinessActionExecutionContext
  ) {
    const configuration = this.configurationFor(request);
    const credential = this.credential(configuration, context);
    assertAdapterRequest(request, this.declaration, configuration);
    const input = validateCapabilityInput<{
      companyId: string;
      to: string[];
      cc: string[];
      subject: string;
      text?: string;
      html?: string;
      replyTo?: string;
    }>("email.send", request.input);
    if (input.companyId !== request.scope.companyId) {
      throw new ControlPlaneError("FORBIDDEN", "Email company does not match authoritative Job scope");
    }

    const rfc822MessageId = gmailRfc822MessageId(request.id);
    if (configuration.verificationMode === "provider-object-read") {
      const prior = await this.lookupByRfc822MessageId(configuration, rfc822MessageId, credential);
      if (prior.kind === "found") {
        return this.acceptedFromLookup(
          request,
          configuration,
          prior.messageId,
          [...new Set([...input.to, ...input.cc])],
          this.now().toISOString()
        );
      }
      if (prior.kind === "retryable") {
        return createBusinessActionAdapterResult({
          source: "business-action-adapter",
          requestId: request.id,
          adapterId: this.id,
          adapterVersion: this.version,
          status: "failed",
          retryable: true,
          retryClass: prior.retryClass,
          observedAt: this.now().toISOString()
        });
      }
      if (prior.kind === "terminal") {
        return createBusinessActionAdapterResult({
          source: "business-action-adapter",
          requestId: request.id,
          adapterId: this.id,
          adapterVersion: this.version,
          status: "rejected",
          retryable: false,
          retryClass: prior.retryClass,
          observedAt: this.now().toISOString()
        });
      }
      if (prior.kind === "malformed") {
        return createBusinessActionAdapterResult({
          source: "business-action-adapter",
          requestId: request.id,
          adapterId: this.id,
          adapterVersion: this.version,
          status: "failed",
          retryable: false,
          retryClass: prior.retryClass,
          observedAt: this.now().toISOString()
        });
      }
    }

    let response: Response;
    try {
      response = await this.fetchImpl(
        new URL(
          "users/" + encodeURIComponent(configuration.userId) + "/messages/send",
          configuration.baseUrl
        ),
        {
          method: "POST",
          headers: providerRequestHeaders({
            request,
            credential,
            contentType: "application/json"
          }),
          body: JSON.stringify({ raw: buildMime(input, request.id) }),
          signal: AbortSignal.timeout(request.timeoutMs),
          redirect: "manual"
        }
      );
    } catch {
      if (configuration.verificationMode === "provider-object-read") {
        return this.ambiguousAcceptance(request, configuration, rfc822MessageId, "transport");
      }
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

    let parsed: z.infer<typeof gmailSendResponseSchema>;
    try {
      const raw = await readBoundedJson(response, configuration.maxResponseBytes);
      assertProviderJsonSuccess(raw);
      parsed = gmailSendResponseSchema.parse(raw);
    } catch {
      if (configuration.verificationMode === "provider-object-read") {
        return this.ambiguousAcceptance(request, configuration, rfc822MessageId, "malformed-response");
      }
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

    return this.acceptedFromLookup(
      request,
      configuration,
      parsed.id,
      [...new Set([...input.to, ...input.cc])],
      observedAt
    );
  }

  async status(
    input: {
      requestId: string;
      providerOperationId: string;
    },
    context?: BusinessActionExecutionContext
  ): Promise<BusinessActionStatus> {
    const operation = parseProviderOperationId(
      this.configurations,
      input.providerOperationId
    );
    const { configuration } = operation;
    const credential = this.credential(configuration, context);
    if (configuration.verificationMode !== "provider-object-read") {
      throw new ControlPlaneError("UNAVAILABLE", "Gmail object verification is not configured");
    }

    if (operation.kind === "rfc822") {
      const lookup = await this.lookupByRfc822MessageId(configuration, operation.value, credential);
      const state: BusinessActionStatus["state"] = lookup.kind === "found"
        ? "completed"
        : lookup.kind === "terminal" || lookup.kind === "malformed"
          ? "failed"
          : "running";
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

    let response: Response;
    try {
      const url = new URL(
        "users/" + encodeURIComponent(configuration.userId) + "/messages/" + encodeURIComponent(operation.value),
        configuration.baseUrl
      );
      url.searchParams.set("format", "minimal");
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: "Bearer " + credential },
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
    if (response.ok) {
      try {
        const raw = await readBoundedJson(response, configuration.maxResponseBytes);
        assertProviderJsonSuccess(raw);
        const parsed = gmailGetResponseSchema.parse(raw);
        state = parsed.id === operation.value ? "completed" : "failed";
      } catch {
        state = "failed";
      }
    } else {
      await readBoundedJson(response, configuration.maxResponseBytes).catch(() => ({}));
      state = [404, 408, 409, 425, 429].includes(response.status) || response.status >= 500
        ? "running"
        : "failed";
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

export function readGmailProviderConfigurationsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const raw = env.GETDONE_GMAIL_ACTIONS_JSON?.trim();
  if (!raw) throw new ControlPlaneError("UNAVAILABLE", "GETDONE_GMAIL_ACTIONS_JSON is required");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", "GETDONE_GMAIL_ACTIONS_JSON must be valid JSON");
  }
  return z.array(z.object({
    id: z.string().min(1),
    companyId: z.string().min(1),
    environment: environmentSchema,
    credentialProviderId: z.string().min(1),
    userId: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    maxResponseBytes: z.number().int().optional(),
    verificationMode: z.enum(["provider-acceptance-only", "provider-object-read"]).optional()
  }).strict()).min(1).parse(parsed) as readonly GmailProviderConfiguration[];
}
