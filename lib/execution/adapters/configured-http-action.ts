import { z } from "zod";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { validateCapabilityInput } from "@/lib/domain/capabilities";
import {
  assertAuthorizedBusinessActionRequest,
  createBusinessActionAdapterResult,
  type AuthorizedBusinessActionRequest,
  type BusinessActionAdapter,
  type BusinessActionStatus
} from "@/lib/execution/adapters/business-action";

export const CONFIGURED_HTTP_ACTION_ADAPTER_VERSION = "1.0.0";

const inputSchema = z.object({
  companyId: z.string().min(1),
  operation: z.string().min(1),
  payload: z.record(z.unknown())
}).strict();

export interface ConfiguredHttpOperation {
  name: string;
  url: string;
  authorizationEnv?: string;
  authorizationScheme?: "Bearer" | "Basic";
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
  const url = new URL(operation.url);
  if (url.username || url.password || url.hash) {
    throw new ControlPlaneError("VALIDATION_FAILED", "HTTP operation URL cannot contain credentials or fragments");
  }
  const localDevelopment = allowInsecureDevelopment
    && url.protocol === "http:"
    && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localDevelopment) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Configured HTTP operations must use HTTPS");
  }
  const maxResponseBytes = operation.maxResponseBytes ?? 1_000_000;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 5_000_000) {
    throw new ControlPlaneError("VALIDATION_FAILED", "HTTP maxResponseBytes must be from 1 to 5000000");
  }
  if (operation.authorizationEnv && !/^[A-Z][A-Z0-9_]*$/.test(operation.authorizationEnv)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "HTTP authorizationEnv must be an environment variable name");
  }
  return Object.freeze({ ...operation, url: url.toString(), maxResponseBytes });
}

async function boundedBody(response: Response, limit: number) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) {
    throw new ControlPlaneError("UNAVAILABLE", "HTTP action response exceeds configured size limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limit) {
    throw new ControlPlaneError("UNAVAILABLE", "HTTP action response exceeds configured size limit");
  }
  return new TextDecoder().decode(bytes);
}

export class ConfiguredHttpActionAdapter implements BusinessActionAdapter {
  readonly id = "configured-http-action";
  readonly version = CONFIGURED_HTTP_ACTION_ADAPTER_VERSION;

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
    assertAuthorizedBusinessActionRequest(request);
    if (request.capability !== "http.request") {
      throw new ControlPlaneError("FORBIDDEN", "Configured HTTP adapter only accepts http.request");
    }
    const input = inputSchema.parse(validateCapabilityInput("http.request", request.input));
    if (input.companyId !== request.scope.companyId) {
      throw new ControlPlaneError("FORBIDDEN", "HTTP action company does not match authoritative Job scope");
    }
    const operation = this.operations.get(input.operation);
    if (!operation) {
      throw new ControlPlaneError("POLICY_BLOCKED", `HTTP operation is not configured: ${input.operation}`);
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": request.idempotencyKey,
      "x-getdone-job-id": request.jobId,
      "x-getdone-request-id": request.id
    };
    if (operation.authorizationEnv) {
      const credential = this.env[operation.authorizationEnv]?.trim();
      if (!credential) {
        throw new ControlPlaneError("UNAVAILABLE", `Credential is unavailable for HTTP operation ${operation.name}`);
      }
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
        observedAt: this.now().toISOString()
      });
    }

    const observedAt = this.now().toISOString();
    const body = await boundedBody(response, operation.maxResponseBytes);
    if (!response.ok) {
      return createBusinessActionAdapterResult({
        source: "business-action-adapter",
        requestId: request.id,
        adapterId: this.id,
        adapterVersion: this.version,
        status: response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status)
          ? "rejected"
          : "failed",
        retryable: response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
        observedAt
      });
    }

    const providerOperationId = response.headers.get("x-provider-operation-id")
      || `http:${request.id}`;
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
    url: z.string().url(),
    authorizationEnv: z.string().optional(),
    authorizationScheme: z.enum(["Bearer", "Basic"]).optional(),
    maxResponseBytes: z.number().int().optional()
  }).strict()).min(1).parse(parsed) as readonly ConfiguredHttpOperation[];
}
