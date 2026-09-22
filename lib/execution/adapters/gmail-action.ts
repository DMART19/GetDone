import { z } from "zod";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { validateCapabilityInput } from "@/lib/domain/capabilities";
import {
  createBusinessActionAdapterResult,
  createBusinessActionStatus,
  type AuthorizedBusinessActionRequest,
  type BusinessActionAdapter,
  type BusinessActionStatus
} from "@/lib/execution/adapters/business-action";
import {
  assertAdapterRequest,
  assertCredentialReference,
  classifyHttpFailure,
  providerRequestHeaders,
  readBoundedJson,
  resolveCredentialReference,
  type BusinessActionAdapterDeclaration
} from "@/lib/execution/adapters/ordinary-integration-framework";

export const GMAIL_BUSINESS_ACTION_ADAPTER_VERSION = "1.0.0";

const gmailSendResponseSchema = z.object({
  id: z.string().min(1).max(500),
  threadId: z.string().min(1).max(500).optional()
}).passthrough();

const gmailGetResponseSchema = z.object({
  id: z.string().min(1).max(500)
}).passthrough();

const environmentSchema = z.enum(["development", "staging", "production"]);

export interface GmailProviderConfiguration {
  id: string;
  companyId: string;
  environment: z.infer<typeof environmentSchema>;
  credentialRef: string;
  verificationCredentialRef?: string;
  userId?: string;
  baseUrl?: string;
  maxResponseBytes?: number;
  verificationMode?: "provider-acceptance-only" | "provider-object-read";
}

export interface GmailBusinessActionAdapterOptions {
  fetchImpl?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}

type ValidatedGmailConfiguration = ReturnType<typeof validateConfiguration>;

function validateConfiguration(configuration: GmailProviderConfiguration) {
  if (!/^[A-Za-z0-9._-]+$/.test(configuration.id)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Gmail provider configuration id is invalid");
  }
  assertCredentialReference(configuration.credentialRef, "Gmail credential reference");
  if (configuration.verificationCredentialRef) {
    assertCredentialReference(
      configuration.verificationCredentialRef,
      "Gmail verification credential reference"
    );
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
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} cannot contain CR/LF`);
  }
}

function encodeSubject(subject: string) {
  rejectHeaderInjection(subject, "Email subject");
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
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
  const headers = [
    `To: ${input.to.join(", ")}`,
    ...(input.cc.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    `Subject: ${encodeSubject(input.subject)}`,
    ...(input.replyTo ? [`Reply-To: ${input.replyTo}`] : []),
    "MIME-Version: 1.0"
  ];

  let body: string;
  if (input.text !== undefined && input.html !== undefined) {
    const boundary = `getdone-${Buffer.from(requestId).toString("base64url").slice(0, 32)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      input.text,
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      input.html,
      `--${boundary}--`
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

function parseProviderOperationId(
  configurations: ReadonlyMap<string, ValidatedGmailConfiguration>,
  providerOperationId: string
) {
  const match = /^gmail:([^:]+):(.+)$/.exec(providerOperationId);
  const configuration = match ? configurations.get(match[1]) : undefined;
  if (!match || !configuration) {
    throw new ControlPlaneError("NOT_FOUND", "Gmail provider operation is not configured");
  }
  return { configuration, messageId: match[2] };
}

export class GmailBusinessActionAdapter implements BusinessActionAdapter {
  readonly id = "gmail-business-action";
  readonly version = GMAIL_BUSINESS_ACTION_ADAPTER_VERSION;
  readonly declaration: BusinessActionAdapterDeclaration = Object.freeze({
    capability: "email.send",
    provider: "gmail",
    credentialMode: "credential-reference",
    minimumScopes: Object.freeze(["https://www.googleapis.com/auth/gmail.send"]),
    verificationScopes: Object.freeze(["https://www.googleapis.com/auth/gmail.readonly"]),
    timeoutMs: Object.freeze({ min: 100, max: 120_000 }),
    idempotency: "required",
    retryTaxonomy: Object.freeze([
      "none", "transport", "timeout", "rate-limit", "provider-4xx",
      "provider-5xx", "malformed-response", "verification-pending"
    ]),
    providerOperationId: "required",
    statusResume: "supported",
    maxResponseBytes: 1_000_000,
    auditEvidence: "hashed-provider-evidence",
    verificationStrategy: "provider-object-read",
    cancellation: "not-supported",
    tenantEnvironmentBinding: true,
    truthSemantics: "provider-acceptance-is-not-business-truth"
  });

  private readonly configurations: ReadonlyMap<string, ValidatedGmailConfiguration>;
  private readonly fetchImpl: typeof fetch;
  private readonly env: Readonly<Record<string, string | undefined>>;
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
    this.env = options.env ?? process.env;
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

  async execute(request: AuthorizedBusinessActionRequest) {
    const configuration = this.configurationFor(request);
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

    const credential = resolveCredentialReference(
      configuration.credentialRef,
      this.env,
      "Gmail send credential"
    );
    let response: Response;
    try {
      response = await this.fetchImpl(
        new URL(
          `users/${encodeURIComponent(configuration.userId)}/messages/send`,
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
          signal: AbortSignal.timeout(request.timeoutMs)
        }
      );
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

    let parsed: z.infer<typeof gmailSendResponseSchema>;
    try {
      parsed = gmailSendResponseSchema.parse(
        await readBoundedJson(response, configuration.maxResponseBytes)
      );
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

    const providerOperationId = `gmail:${configuration.id}:${parsed.id}`;
    const output = {
      messageId: parsed.id,
      providerReference: providerOperationId,
      accepted: [...new Set([...input.to, ...input.cc])],
      rejected: [],
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

  async status(input: {
    requestId: string;
    providerOperationId: string;
  }): Promise<BusinessActionStatus> {
    const { configuration, messageId } = parseProviderOperationId(
      this.configurations,
      input.providerOperationId
    );
    if (configuration.verificationMode !== "provider-object-read") {
      throw new ControlPlaneError("UNAVAILABLE", "Gmail object verification is not configured");
    }
    const credential = resolveCredentialReference(
      configuration.verificationCredentialRef ?? configuration.credentialRef,
      this.env,
      "Gmail verification credential"
    );
    let response: Response;
    try {
      const url = new URL(
        `users/${encodeURIComponent(configuration.userId)}/messages/${encodeURIComponent(messageId)}`,
        configuration.baseUrl
      );
      url.searchParams.set("format", "minimal");
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(30_000)
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
        const parsed = gmailGetResponseSchema.parse(
          await readBoundedJson(response, configuration.maxResponseBytes)
        );
        state = parsed.id === messageId ? "completed" : "failed";
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
    credentialRef: z.string().min(1),
    verificationCredentialRef: z.string().optional(),
    userId: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    maxResponseBytes: z.number().int().optional(),
    verificationMode: z.enum(["provider-acceptance-only", "provider-object-read"]).optional()
  }).strict()).min(1).parse(parsed) as readonly GmailProviderConfiguration[];
}
