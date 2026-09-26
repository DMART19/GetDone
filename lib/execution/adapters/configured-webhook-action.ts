import { createHmac } from "node:crypto";
import { z } from "zod";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
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
  interpolateOperationUrl,
  providerRequestHeaders,
  readBoundedResponseBody,
  requireBrokeredCredential,
  ORDINARY_INTEGRATION_RETRY_TAXONOMY,
  type BusinessActionAdapterDeclaration
} from "@/lib/execution/adapters/ordinary-integration-framework";

export const CONFIGURED_WEBHOOK_ACTION_ADAPTER_VERSION = "1.1.0";

const inputSchema = z.object({
  companyId: z.string().min(1),
  operation: z.string().min(1),
  payload: z.record(z.unknown())
}).strict();

const environmentSchema = z.enum(["development", "staging", "production"]);

export interface ConfiguredWebhookOperation {
  name: string;
  companyId: string;
  environment: z.infer<typeof environmentSchema>;
  url: string;
  credentialProviderId?: string;
  minimumScopes?: readonly string[];
  signatureMode?: "bearer" | "hmac-sha256";
  maxResponseBytes?: number;
  consequential?: boolean;
  verification?: {
    url: string;
  };
  cancellation?: {
    url: string;
  };
}

export interface ConfiguredWebhookActionAdapterOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

type ValidatedWebhookOperation = ReturnType<typeof validateOperation>;

function validateHttpsTemplate(value: string, label: string) {
  const probe = value.replace("{providerOperationId}", "provider-operation");
  const url = new URL(probe);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be credential-free HTTPS`);
  }
  return value;
}

function validateOperation(operation: ConfiguredWebhookOperation) {
  if (!/^[A-Za-z0-9._:-]+$/.test(operation.name)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Webhook operation name is invalid");
  }
  if (operation.credentialProviderId && !/^[A-Za-z0-9._:@+-]{1,200}$/.test(operation.credentialProviderId)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Webhook credentialProviderId is invalid");
  }
  if (operation.signatureMode && !operation.credentialProviderId) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Webhook signature mode requires a credential provider");
  }
  const maxResponseBytes = operation.maxResponseBytes ?? 256_000;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 1_000_000) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Webhook maxResponseBytes must be 1-1000000");
  }
  if (operation.consequential && !operation.verification) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Consequential webhook operations require an independent verification endpoint"
    );
  }
  return Object.freeze({
    ...operation,
    url: validateHttpsTemplate(operation.url, "Webhook URL"),
    verification: operation.verification
      ? Object.freeze({
          ...operation.verification,
          url: validateHttpsTemplate(operation.verification.url, "Webhook verification URL")
        })
      : undefined,
    cancellation: operation.cancellation
      ? Object.freeze({
          ...operation.cancellation,
          url: validateHttpsTemplate(operation.cancellation.url, "Webhook cancellation URL")
        })
      : undefined,
    minimumScopes: Object.freeze([...(operation.minimumScopes ?? [])]),
    signatureMode: operation.signatureMode ?? (operation.credentialProviderId ? "bearer" : undefined),
    maxResponseBytes
  });
}

function operationFromProviderId(
  operations: ReadonlyMap<string, ValidatedWebhookOperation>,
  providerOperationId: string
) {
  const match = /^webhook:([^:]+):/.exec(providerOperationId);
  const operation = match ? operations.get(match[1]) : undefined;
  if (!operation) {
    throw new ControlPlaneError("NOT_FOUND", "Webhook provider operation is not configured");
  }
  return operation;
}

function requirement(operation: ValidatedWebhookOperation) {
  return operation.credentialProviderId
    ? { providerId: operation.credentialProviderId, requiredScopes: operation.minimumScopes }
    : null;
}

function credential(
  operation: ValidatedWebhookOperation,
  context: BusinessActionExecutionContext | undefined
) {
  const value = requirement(operation);
  return value
    ? requireBrokeredCredential(context, value, "webhook.send")
    : undefined;
}

function signedHeaders(
  operation: ValidatedWebhookOperation,
  request: AuthorizedBusinessActionRequest,
  body: string,
  material: string | undefined,
  timestamp: string
) {
  const headers = providerRequestHeaders({
    request,
    credential: operation.signatureMode === "bearer" ? material : undefined,
    contentType: "application/json"
  });
  if (operation.signatureMode === "hmac-sha256") {
    if (!material) {
      throw new ControlPlaneError("FORBIDDEN", "Signed webhook requires brokered credential material");
    }
    const signature = createHmac("sha256", material)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    headers["x-getdone-signature"] = `sha256=${signature}`;
    headers["x-getdone-signature-timestamp"] = timestamp;
  }
  return headers;
}

export class ConfiguredWebhookActionAdapter implements BusinessActionAdapter {
  readonly id = "configured-webhook-action";
  readonly version = CONFIGURED_WEBHOOK_ACTION_ADAPTER_VERSION;
  readonly declaration: BusinessActionAdapterDeclaration = Object.freeze({
    capability: "webhook.send",
    provider: "configured-webhook",
    credentialMode: "brokered-lease",
    minimumScopes: Object.freeze([]),
    timeoutMs: Object.freeze({ min: 100, max: 120_000 }),
    idempotency: "required",
    retryTaxonomy: ORDINARY_INTEGRATION_RETRY_TAXONOMY,
    providerOperationId: "required",
    statusResume: "supported",
    maxResponseBytes: 1_000_000,
    auditEvidence: "hashed-provider-evidence",
    verificationStrategy: "configured-independent-endpoint",
    cancellation: "configured",
    cancellationSemantics: "configured-provider-defined",
    tenantEnvironmentBinding: true,
    truthSemantics: "provider-acceptance-is-not-business-truth"
  });

  private readonly operations: ReadonlyMap<string, ValidatedWebhookOperation>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(
    operations: readonly ConfiguredWebhookOperation[],
    options: ConfiguredWebhookActionAdapterOptions = {}
  ) {
    const entries = operations.map((operation) => {
      const validated = validateOperation(operation);
      return [validated.name, validated] as const;
    });
    if (entries.length === 0 || new Set(entries.map(([name]) => name)).size !== entries.length) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Webhook operations must be non-empty and unique");
    }
    this.operations = new Map(entries);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  credentialRequirement(request: AuthorizedBusinessActionRequest) {
    const input = inputSchema.parse(validateCapabilityInput("webhook.send", request.input));
    const operation = this.operations.get(input.operation);
    if (!operation) {
      throw new ControlPlaneError("POLICY_BLOCKED", `Webhook operation is not configured: ${input.operation}`);
    }
    return requirement(operation);
  }

  async execute(
    request: AuthorizedBusinessActionRequest,
    context?: BusinessActionExecutionContext
  ) {
    const input = inputSchema.parse(validateCapabilityInput("webhook.send", request.input));
    const operation = this.operations.get(input.operation);
    if (!operation) {
      throw new ControlPlaneError("POLICY_BLOCKED", `Webhook operation is not configured: ${input.operation}`);
    }
    assertAdapterRequest(request, this.declaration, operation);
    if (input.companyId !== request.scope.companyId) {
      throw new ControlPlaneError("FORBIDDEN", "Webhook company does not match authoritative Job scope");
    }

    const material = credential(operation, context);
    const body = JSON.stringify({
      requestId: request.id,
      jobId: request.jobId,
      companyId: input.companyId,
      operation: operation.name,
      payload: input.payload
    });
    const timestamp = this.now().toISOString();

    let response: Response;
    try {
      response = await this.fetchImpl(operation.url, {
        method: "POST",
        headers: signedHeaders(operation, request, body, material, timestamp),
        body,
        signal: AbortSignal.timeout(request.timeoutMs)
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
    const responseBody = await readBoundedResponseBody(response, operation.maxResponseBytes);
    if (!response.ok) {
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

    const rawOperationId = response.headers.get("x-provider-operation-id")
      ?? `webhook:${operation.name}:${request.id}`;
    const externalId = assertProviderOperationId(rawOperationId);
    const providerOperationId = externalId.startsWith(`webhook:${operation.name}:`)
      ? externalId
      : `webhook:${operation.name}:${externalId}`;
    const output = {
      providerOperationId,
      responseStatus: response.status,
      responseBodyHash: sha256Hex(responseBody),
      observedAt
    };
    return createBusinessActionAdapterResult({
      source: "business-action-adapter",
      requestId: request.id,
      adapterId: this.id,
      adapterVersion: this.version,
      status: operation.consequential ? "accepted" : "completed",
      providerOperationId,
      output,
      retryable: false,
      retryClass: "none",
      observedAt
    });
  }

  async status(
    input: { requestId: string; providerOperationId: string },
    context?: BusinessActionExecutionContext
  ): Promise<BusinessActionStatus> {
    const operation = operationFromProviderId(this.operations, input.providerOperationId);
    if (!operation.verification) {
      throw new ControlPlaneError("UNAVAILABLE", "Webhook operation has no verification surface");
    }
    const material = credential(operation, context);
    let response: Response;
    try {
      response = await this.fetchImpl(
        interpolateOperationUrl(operation.verification.url, input.providerOperationId),
        {
          method: "GET",
          headers: material ? { authorization: `Bearer ${material}` } : undefined,
          signal: AbortSignal.timeout(30_000)
        }
      );
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
    await readBoundedResponseBody(response, operation.maxResponseBytes);
    const state = response.ok
      ? "completed"
      : ([404, 408, 409, 425, 429].includes(response.status) || response.status >= 500)
        ? "running"
        : "failed";
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
    input: { requestId: string; providerOperationId: string; reason: string },
    context?: BusinessActionExecutionContext
  ): Promise<BusinessActionStatus> {
    const operation = operationFromProviderId(this.operations, input.providerOperationId);
    if (!operation.cancellation) {
      throw new ControlPlaneError("UNAVAILABLE", "Webhook operation does not support cancellation");
    }
    if (!input.reason.trim()) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Webhook cancellation reason is required");
    }
    const material = credential(operation, context);
    let response: Response;
    try {
      response = await this.fetchImpl(
        interpolateOperationUrl(operation.cancellation.url, input.providerOperationId),
        {
          method: "POST",
          headers: {
            ...(material ? { authorization: `Bearer ${material}` } : {}),
            "content-type": "application/json"
          },
          body: JSON.stringify({ reason: input.reason }),
          signal: AbortSignal.timeout(30_000)
        }
      );
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
    await readBoundedResponseBody(response, operation.maxResponseBytes);
    return createBusinessActionStatus({
      source: "business-action-adapter",
      requestId: input.requestId,
      providerOperationId: input.providerOperationId,
      adapterId: this.id,
      adapterVersion: this.version,
      state: response.ok
        ? "compensated"
        : response.status >= 500 || response.status === 429
          ? "running"
          : "failed",
      observedAt: this.now().toISOString()
    });
  }
}

export function readConfiguredWebhookOperationsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const raw = env.GETDONE_WEBHOOK_ACTIONS_JSON?.trim();
  if (!raw) throw new ControlPlaneError("UNAVAILABLE", "GETDONE_WEBHOOK_ACTIONS_JSON is required");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", "GETDONE_WEBHOOK_ACTIONS_JSON must be valid JSON");
  }
  return z.array(z.object({
    name: z.string().min(1),
    companyId: z.string().min(1),
    environment: environmentSchema,
    url: z.string().min(1),
    credentialProviderId: z.string().optional(),
    minimumScopes: z.array(z.string().min(1)).optional(),
    signatureMode: z.enum(["bearer", "hmac-sha256"]).optional(),
    maxResponseBytes: z.number().int().optional(),
    consequential: z.boolean().optional(),
    verification: z.object({
      url: z.string().min(1)
    }).strict().optional(),
    cancellation: z.object({
      url: z.string().min(1)
    }).strict().optional()
  }).strict()).min(1).parse(parsed) as readonly ConfiguredWebhookOperation[];
}
