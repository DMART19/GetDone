import { z } from "zod";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { validateCapabilityInput } from "@/lib/domain/capabilities";
import {
  createBusinessActionAdapterResult,
  type AuthorizedBusinessActionRequest,
  type BusinessActionAdapter,
  type BusinessActionStatus
} from "@/lib/execution/adapters/business-action";
import {
  assertAdapterRequest,
  assertCredentialReference,
  assertProviderOperationId,
  classifyHttpFailure,
  readBoundedResponseBody,
  resolveCredentialReference,
  type BusinessActionAdapterDeclaration
} from "@/lib/execution/adapters/ordinary-integration-framework";

export const CONFIGURED_HTTP_ACTION_ADAPTER_VERSION = "1.1.0";

const environmentSchema = z.enum(["development", "staging", "production"]);
const inputSchema = z.object({
  companyId: z.string().min(1),
  operation: z.string().min(1),
  payload: z.record(z.unknown())
}).strict();

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
}

export interface ConfiguredHttpActionAdapterOptions {
  fetchImpl?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  allowInsecureDevelopment?: boolean;
}

function validateOperation(operation: ConfiguredHttpOperation, allowInsecureDevelopment: boolean) {
  if (!/^[A-Za-z0-9._:-]+$/.test(operation.name)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "HTTP operation name is invalid");
  }
  if (!operation.companyId.trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", "HTTP operation companyId is required");
  }
  const url = new URL(operation.url);
  if (url.username || url.password || url.hash) {
    throw new ControlPlaneError("VALIDATION_FAILED", "HTTP operation URL cannot contain credentials or fragments");
  }
  const localDevelopment = allowInsecureDevelopment
    && operation.environment === "development"
    && url.protocol === "http:"
    && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localDevelopment) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Configured HTTP operations must use HTTPS");
  }
  const maxResponseBytes = operation.maxResponseBytes ?? 1_000_000;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 5_000_000) {
    throw new ControlPlaneError("VALIDATION_FAILED", "HTTP maxResponseBytes must be from 1 to 5000000");
  }
  if (operation.credentialRef) assertCredentialReference(operation.credentialRef, "HTTP credential reference");
  if (operation.authorizationEnv && !/^[A-Z][A-Z0-9_]*$/.test(operation.authorizationEnv)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "HTTP authorizationEnv must be an environment variable name");
  }
  if (operation.credentialRef && operation.authorizationEnv) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Configure only one HTTP credential reference mechanism");
  }
  return Object.freeze({
    ...operation,
    url: url.toString(),
    minimumScopes: Object.freeze([...(operation.minimumScopes ?? [])]),
    maxResponseBytes
  });
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
    statusResume: "not-supported",
    maxResponseBytes: 5_000_000,
    auditEvidence: "hashed-provider-evidence",
    verificationStrategy: "provider-acceptance-only",
    cancellation: "not-supported",
    tenantEnvironmentBinding: true,
    truthSemantics: "provider-acceptance-is-not-business-truth"
  });

  private readonly operations: ReadonlyMap<string, ReturnType<typeof validateOperation>>;
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

    let credential: string | undefined;
    if (operation.credentialRef) {
      credential = resolveCredentialReference(operation.credentialRef, this.env, "HTTP credential");
    } else if (operation.authorizationEnv) {
      credential = this.env[operation.authorizationEnv]?.trim();
      if (!credential) {
        throw new ControlPlaneError("UNAVAILABLE", `Credential is unavailable for HTTP operation ${operation.name}`);
      }
    }

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

    const providerOperationId = assertProviderOperationId(
      response.headers.get("x-provider-operation-id") || `http:${request.id}`
    );
    return createBusinessActionAdapterResult({
      source: "business-action-adapter",
      requestId: request.id,
      adapterId: this.id,
      adapterVersion: this.version,
      status: "completed",
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

  async status(): Promise<BusinessActionStatus> {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "Configured HTTP actions complete synchronously and do not expose a polling surface"
    );
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
  return z.array(z.object({
    name: z.string().min(1),
    companyId: z.string().min(1),
    environment: environmentSchema,
    url: z.string().url(),
    credentialRef: z.string().optional(),
    authorizationEnv: z.string().optional(),
    authorizationScheme: z.enum(["Bearer", "Basic"]).optional(),
    minimumScopes: z.array(z.string().min(1)).optional(),
    maxResponseBytes: z.number().int().optional()
  }).strict()).min(1).parse(parsed) as readonly ConfiguredHttpOperation[];
}
