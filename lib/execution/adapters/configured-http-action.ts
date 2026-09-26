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
  readBoundedResponseBody,
  requireBrokeredCredential,
  ORDINARY_INTEGRATION_RETRY_TAXONOMY,
  type BusinessActionAdapterDeclaration
} from "@/lib/execution/adapters/ordinary-integration-framework";

export const CONFIGURED_HTTP_ACTION_ADAPTER_VERSION = "1.3.0";

const environmentSchema = z.enum(["development", "staging", "production"]);
const inputSchema = z.object({
  companyId: z.string().min(1),
  operation: z.string().min(1),
  payload: z.record(z.unknown())
}).strict();

interface ConfiguredHttpFollowUp {
  url: string;
  method?: "GET" | "POST";
}

export interface ConfiguredHttpOperation {
  name: string;
  companyId: string;
  environment: z.infer<typeof environmentSchema>;
  url: string;
  credentialProviderId?: string;
  authorizationScheme?: "Bearer" | "Basic";
  minimumScopes?: readonly string[];
  maxResponseBytes?: number;
  consequential?: boolean;
  verification?: ConfiguredHttpFollowUp;
  cancellation?: ConfiguredHttpFollowUp;
}

export interface ConfiguredHttpActionAdapterOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  allowInsecureDevelopment?: boolean;
}

type ValidatedOperation = ReturnType<typeof validateOperation>;

function validateUrl(
  value: string,
  label: string,
  allowInsecureDevelopment: boolean,
  environment: z.infer<typeof environmentSchema>
) {
  const probe = value.replace("{providerOperationId}", "provider-operation");
  const url = new URL(probe);
  if (url.username || url.password || url.hash) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} cannot contain credentials or fragments`);
  }
  const localDevelopment = allowInsecureDevelopment
    && environment === "development"
    && url.protocol === "http:"
    && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localDevelopment) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must use HTTPS`);
  }
  return value;
}

function validateFollowUp(
  followUp: ConfiguredHttpFollowUp | undefined,
  label: string,
  allowInsecureDevelopment: boolean,
  environment: z.infer<typeof environmentSchema>
) {
  if (!followUp) return undefined;
  return Object.freeze({
    ...followUp,
    url: validateUrl(followUp.url, label, allowInsecureDevelopment, environment),
    method: followUp.method ?? "GET"
  });
}

function validateOperation(operation: ConfiguredHttpOperation, allowInsecureDevelopment: boolean) {
  if (!/^[A-Za-z0-9._:-]+$/.test(operation.name)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "HTTP operation name is invalid");
  }
  if (!operation.companyId.trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", "HTTP operation companyId is required");
  }
  if (operation.credentialProviderId && !/^[A-Za-z0-9._:@+-]{1,200}$/.test(operation.credentialProviderId)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "HTTP credentialProviderId is invalid");
  }
  const maxResponseBytes = operation.maxResponseBytes ?? 1_000_000;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 5_000_000) {
    throw new ControlPlaneError("VALIDATION_FAILED", "HTTP maxResponseBytes must be from 1 to 5000000");
  }

  const verification = validateFollowUp(
    operation.verification,
    "HTTP verification URL",
    allowInsecureDevelopment,
    operation.environment
  );
  const cancellation = validateFollowUp(
    operation.cancellation,
    "HTTP cancellation URL",
    allowInsecureDevelopment,
    operation.environment
  );
  if (operation.consequential && !verification) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Consequential HTTP operations require an independent verification endpoint"
    );
  }

  return Object.freeze({
    ...operation,
    url: validateUrl(operation.url, "HTTP operation URL", allowInsecureDevelopment, operation.environment),
    verification,
    cancellation,
    minimumScopes: Object.freeze([...(operation.minimumScopes ?? [])]),
    maxResponseBytes
  });
}

function parseProviderOperation(
  operations: ReadonlyMap<string, ValidatedOperation>,
  providerOperationId: string
) {
  const match = /^http:([^:]+):(.+)$/.exec(providerOperationId);
  const operation = match ? operations.get(match[1]) : undefined;
  if (!match || !operation) {
    throw new ControlPlaneError("NOT_FOUND", "HTTP provider operation is not configured");
  }
  return operation;
}

function credentialRequirement(operation: ValidatedOperation) {
  return operation.credentialProviderId
    ? {
        providerId: operation.credentialProviderId,
        requiredScopes: operation.minimumScopes
      }
    : null;
}

function credential(
  operation: ValidatedOperation,
  context: BusinessActionExecutionContext | undefined
) {
  const requirement = credentialRequirement(operation);
  return requirement
    ? requireBrokeredCredential(context, requirement, "http.request")
    : undefined;
}

export class ConfiguredHttpActionAdapter implements BusinessActionAdapter {
  readonly id = "configured-http-action";
  readonly version = CONFIGURED_HTTP_ACTION_ADAPTER_VERSION;
  readonly declaration: BusinessActionAdapterDeclaration = Object.freeze({
    capability: "http.request",
    provider: "configured-https",
    credentialMode: "brokered-lease",
    minimumScopes: Object.freeze([]),
    timeoutMs: Object.freeze({ min: 100, max: 120_000 }),
    idempotency: "required",
    retryTaxonomy: ORDINARY_INTEGRATION_RETRY_TAXONOMY,
    providerOperationId: "required",
    statusResume: "supported",
    maxResponseBytes: 5_000_000,
    auditEvidence: "hashed-provider-evidence",
    verificationStrategy: "configured-independent-endpoint",
    cancellation: "configured",
    cancellationSemantics: "configured-provider-defined",
    tenantEnvironmentBinding: true,
    truthSemantics: "provider-acceptance-is-not-business-truth"
  });

  private readonly operations: ReadonlyMap<string, ValidatedOperation>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(
    operations: readonly ConfiguredHttpOperation[],
    options: ConfiguredHttpActionAdapterOptions = {}
  ) {
    const entries = operations.map((operation) => {
      const validated = validateOperation(operation, options.allowInsecureDevelopment === true);
      return [validated.name, validated] as const;
    });
    if (entries.length === 0 || new Set(entries.map(([name]) => name)).size !== entries.length) {
      throw new ControlPlaneError("VALIDATION_FAILED", "HTTP operations must be non-empty and uniquely named");
    }
    this.operations = new Map(entries);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  credentialRequirement(request: AuthorizedBusinessActionRequest) {
    const input = inputSchema.parse(validateCapabilityInput("http.request", request.input));
    const operation = this.operations.get(input.operation);
    if (!operation) {
      throw new ControlPlaneError("POLICY_BLOCKED", `HTTP operation is not configured: ${input.operation}`);
    }
    return credentialRequirement(operation);
  }

  async execute(
    request: AuthorizedBusinessActionRequest,
    context?: BusinessActionExecutionContext
  ) {
    const input = inputSchema.parse(validateCapabilityInput("http.request", request.input));
    const operation = this.operations.get(input.operation);
    if (!operation) {
      throw new ControlPlaneError("POLICY_BLOCKED", `HTTP operation is not configured: ${input.operation}`);
    }
    assertAdapterRequest(request, this.declaration, operation);
    if (input.companyId !== request.scope.companyId) {
      throw new ControlPlaneError("FORBIDDEN", "HTTP action company does not match authoritative Job scope");
    }

    const material = credential(operation, context);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": request.idempotencyKey,
      "x-getdone-job-id": request.jobId,
      "x-getdone-request-id": request.id
    };
    if (material) {
      headers.authorization = `${operation.authorizationScheme ?? "Bearer"} ${material}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(operation.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          operation: operation.name,
          requestId: request.id,
          jobId: request.jobId,
          companyId: input.companyId,
          payload: input.payload
        }),
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
    const body = await readBoundedResponseBody(response, operation.maxResponseBytes);
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

    const externalId = assertProviderOperationId(
      response.headers.get("x-provider-operation-id") || request.id
    );
    const providerOperationId = externalId.startsWith(`http:${operation.name}:`)
      ? externalId
      : `http:${operation.name}:${externalId}`;
    return createBusinessActionAdapterResult({
      source: "business-action-adapter",
      requestId: request.id,
      adapterId: this.id,
      adapterVersion: this.version,
      status: operation.consequential ? "accepted" : "completed",
      providerOperationId,
      output: {
        providerOperationId,
        responseStatus: response.status,
        responseBodyHash: sha256Hex(body),
        observedAt
      },
      retryable: false,
      retryClass: "none",
      observedAt
    });
  }

  async status(
    input: { requestId: string; providerOperationId: string },
    context?: BusinessActionExecutionContext
  ): Promise<BusinessActionStatus> {
    const operation = parseProviderOperation(this.operations, input.providerOperationId);
    if (!operation.verification) {
      throw new ControlPlaneError("UNAVAILABLE", "HTTP operation has no verification surface");
    }
    const material = credential(operation, context);
    let response: Response;
    try {
      response = await this.fetchImpl(
        interpolateOperationUrl(operation.verification.url, input.providerOperationId),
        {
          method: operation.verification.method,
          headers: material
            ? { authorization: `${operation.authorizationScheme ?? "Bearer"} ${material}` }
            : undefined,
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
    const operation = parseProviderOperation(this.operations, input.providerOperationId);
    if (!operation.cancellation) {
      throw new ControlPlaneError("UNAVAILABLE", "HTTP operation does not support cancellation");
    }
    if (!input.reason.trim()) {
      throw new ControlPlaneError("VALIDATION_FAILED", "HTTP cancellation reason is required");
    }
    const material = credential(operation, context);
    let response: Response;
    try {
      response = await this.fetchImpl(
        interpolateOperationUrl(operation.cancellation.url, input.providerOperationId),
        {
          method: operation.cancellation.method,
          headers: {
            ...(material
              ? { authorization: `${operation.authorizationScheme ?? "Bearer"} ${material}` }
              : {}),
            "content-type": "application/json"
          },
          body: operation.cancellation.method === "POST"
            ? JSON.stringify({ reason: input.reason })
            : undefined,
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

export function readConfiguredHttpOperationsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const raw = env.GETDONE_HTTP_ACTIONS_JSON?.trim();
  if (!raw) throw new ControlPlaneError("UNAVAILABLE", "GETDONE_HTTP_ACTIONS_JSON is required");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", "GETDONE_HTTP_ACTIONS_JSON must be valid JSON");
  }
  const followUp = z.object({
    url: z.string().min(1),
    method: z.enum(["GET", "POST"]).optional()
  }).strict();
  return z.array(z.object({
    name: z.string().min(1),
    companyId: z.string().min(1),
    environment: environmentSchema,
    url: z.string().url(),
    credentialProviderId: z.string().optional(),
    authorizationScheme: z.enum(["Bearer", "Basic"]).optional(),
    minimumScopes: z.array(z.string().min(1)).optional(),
    maxResponseBytes: z.number().int().optional(),
    consequential: z.boolean().optional(),
    verification: followUp.optional(),
    cancellation: followUp.optional()
  }).strict()).min(1).parse(parsed) as readonly ConfiguredHttpOperation[];
}
