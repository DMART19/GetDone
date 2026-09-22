import { z } from "zod";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
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
  assertProviderOperationId,
  classifyHttpFailure,
  interpolateOperationUrl,
  readBoundedResponseBody,
  resolveCredentialReference,
  type BusinessActionAdapterDeclaration
} from "@/lib/execution/adapters/ordinary-integration-framework";

export const CONFIGURED_HTTP_ACTION_ADAPTER_VERSION = "1.2.0";

const environmentSchema = z.enum(["development", "staging", "production"]);
const inputSchema = z.object({
  companyId: z.string().min(1),
  operation: z.string().min(1),
  payload: z.record(z.unknown())
}).strict();

interface ConfiguredHttpFollowUp {
  url: string;
  credentialRef?: string;
  method?: "GET" | "POST";
}

export interface ConfiguredHttpOperation {
  name: string;
  companyId: string;
  environment: z.infer<typeof environmentSchema>;
  url: string;
  credentialRef?: string;
  /** @deprecated use credentialRef=env:VARIABLE */
  authorizationEnv?: string;
  authorizationScheme?: "Bearer" | "Basic";
  minimumScopes?: readonly string[];
  maxResponseBytes?: number;
  consequential?: boolean;
  verification?: ConfiguredHttpFollowUp;
  cancellation?: ConfiguredHttpFollowUp;
}

export interface ConfiguredHttpActionAdapterOptions {
  fetchImpl?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
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
  if (followUp.credentialRef) {
    assertCredentialReference(followUp.credentialRef, `${label} credential reference`);
  }
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
  const maxResponseBytes = operation.maxResponseBytes ?? 1_000_000;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 5_000_000) {
    throw new ControlPlaneError("VALIDATION_FAILED", "HTTP maxResponseBytes must be from 1 to 5000000");
  }
  if (operation.credentialRef) {
    assertCredentialReference(operation.credentialRef, "HTTP credential reference");
  }
  if (operation.authorizationEnv && !/^[A-Z][A-Z0-9_]*$/.test(operation.authorizationEnv)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "HTTP authorizationEnv must be an environment variable name");
  }
  if (operation.credentialRef && operation.authorizationEnv) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Configure only one HTTP credential reference mechanism");
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

export class ConfiguredHttpActionAdapter implements BusinessActionAdapter {
  readonly id = "configured-http-action";
  readonly version = CONFIGURED_HTTP_ACTION_ADAPTER_VERSION;
  readonly declaration: BusinessActionAdapterDeclaration = Object.freeze({
    capability: "http.request",
    provider: "configured-https",
    credentialMode: "credential-reference",
    minimumScopes: Object.freeze([]),
    timeoutMs: Object.freeze({ min: 100, max: 120_000 }),
    idempotency: "required",
    retryTaxonomy: Object.freeze([
      "none", "transport", "timeout", "rate-limit", "provider-4xx",
      "provider-5xx", "malformed-response", "verification-pending"
    ]),
    providerOperationId: "required",
    statusResume: "supported",
    maxResponseBytes: 5_000_000,
    auditEvidence: "hashed-provider-evidence",
    verificationStrategy: "configured-independent-endpoint",
    cancellation: "configured",
    tenantEnvironmentBinding: true,
    truthSemantics: "provider-acceptance-is-not-business-truth"
  });

  private readonly operations: ReadonlyMap<string, ValidatedOperation>;
  private readonly fetchImpl: typeof fetch;
  private readonly env: Readonly<Record<string, string | undefined>>;
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
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
  }

  private credential(operation: ValidatedOperation, reference?: string) {
    if (reference) return resolveCredentialReference(reference, this.env, "HTTP credential");
    if (operation.credentialRef) {
      return resolveCredentialReference(operation.credentialRef, this.env, "HTTP credential");
    }
    if (operation.authorizationEnv) {
      const value = this.env[operation.authorizationEnv]?.trim();
      if (!value) {
        throw new ControlPlaneError(
          "UNAVAILABLE",
          `Credential is unavailable for HTTP operation ${operation.name}`
        );
      }
      return value;
    }
    return undefined;
  }

  async execute(request: AuthorizedBusinessActionRequest) {
    const input = inputSchema.parse(validateCapabilityInput("http.request", request.input));
    const operation = this.operations.get(input.operation);
    if (!operation) {
      throw new ControlPlaneError("POLICY_BLOCKED", `HTTP operation is not configured: ${input.operation}`);
    }
    assertAdapterRequest(request, this.declaration, operation);
    if (input.companyId !== request.scope.companyId) {
      throw new ControlPlaneError("FORBIDDEN", "HTTP action company does not match authoritative Job scope");
    }

    const credential = this.credential(operation);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": request.idempotencyKey,
      "x-getdone-job-id": request.jobId,
      "x-getdone-request-id": request.id
    };
    if (credential) {
      headers.authorization = `${operation.authorizationScheme ?? "Bearer"} ${credential}`;
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

  async status(input: {
    requestId: string;
    providerOperationId: string;
  }): Promise<BusinessActionStatus> {
    const operation = parseProviderOperation(this.operations, input.providerOperationId);
    if (!operation.verification) {
      throw new ControlPlaneError("UNAVAILABLE", "HTTP operation has no verification surface");
    }
    const credential = this.credential(operation, operation.verification.credentialRef);
    let response: Response;
    try {
      response = await this.fetchImpl(
        interpolateOperationUrl(operation.verification.url, input.providerOperationId),
        {
          method: operation.verification.method,
          headers: credential
            ? { authorization: `${operation.authorizationScheme ?? "Bearer"} ${credential}` }
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

  async cancel(input: {
    requestId: string;
    providerOperationId: string;
    reason: string;
  }): Promise<BusinessActionStatus> {
    const operation = parseProviderOperation(this.operations, input.providerOperationId);
    if (!operation.cancellation) {
      throw new ControlPlaneError("UNAVAILABLE", "HTTP operation does not support cancellation");
    }
    if (!input.reason.trim()) {
      throw new ControlPlaneError("VALIDATION_FAILED", "HTTP cancellation reason is required");
    }
    const credential = this.credential(operation, operation.cancellation.credentialRef);
    let response: Response;
    try {
      response = await this.fetchImpl(
        interpolateOperationUrl(operation.cancellation.url, input.providerOperationId),
        {
          method: operation.cancellation.method,
          headers: {
            ...(credential
              ? { authorization: `${operation.authorizationScheme ?? "Bearer"} ${credential}` }
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
      state: response.ok ? "cancelled" : response.status >= 500 || response.status === 429 ? "running" : "failed",
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
    credentialRef: z.string().optional(),
    method: z.enum(["GET", "POST"]).optional()
  }).strict();
  return z.array(z.object({
    name: z.string().min(1),
    companyId: z.string().min(1),
    environment: environmentSchema,
    url: z.string().url(),
    credentialRef: z.string().optional(),
    authorizationEnv: z.string().optional(),
    authorizationScheme: z.enum(["Bearer", "Basic"]).optional(),
    minimumScopes: z.array(z.string().min(1)).optional(),
    maxResponseBytes: z.number().int().optional(),
    consequential: z.boolean().optional(),
    verification: followUp.optional(),
    cancellation: followUp.optional()
  }).strict()).min(1).parse(parsed) as readonly ConfiguredHttpOperation[];
}
