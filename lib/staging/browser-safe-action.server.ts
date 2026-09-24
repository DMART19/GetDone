import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { validateCapabilityInput } from "@/lib/domain/capabilities";
import {
  createBusinessActionAdapterResult,
  createBusinessActionStatus,
  type AuthorizedBusinessActionRequest,
  type BusinessActionAdapter
} from "@/lib/execution/adapters/business-action";
import type { BusinessActionAdapterBinding } from "@/lib/execution/adapters/business-action-registry";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";

export const STAGING_BROWSER_SAFE_ADAPTER_VERSION = "1.0.0";

interface SafeProviderObjectRow {
  provider_operation_id: string;
  request_id: string;
  job_id: string;
  company_id: string;
  payload_hash: string;
  created_at: Date | string;
}

function assertEnabled(
  env: Readonly<Record<string, string | undefined>>
) {
  if (
    env.GETDONE_RUNTIME_ENV !== "staging"
    || env.GETDONE_STAGING_BROWSER_E2E !== "true"
  ) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "Staging browser safe provider is disabled"
    );
  }
}

export class StagingBrowserSafeActionAdapter implements BusinessActionAdapter {
  readonly id = "staging-browser-safe-action";
  readonly version = STAGING_BROWSER_SAFE_ADAPTER_VERSION;

  constructor(
    private readonly db: SqlQueryable,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly now: () => Date = () => new Date()
  ) {
    assertEnabled(env);
  }

  credentialRequirement() {
    return null;
  }

  async execute(request: AuthorizedBusinessActionRequest) {
    assertEnabled(this.env);
    if (request.capability !== "http.request") {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Staging browser safe provider only accepts http.request"
      );
    }
    const input = validateCapabilityInput<{
      companyId: string;
      operation: string;
      payload: Record<string, unknown>;
    }>("http.request", request.input);
    if (
      input.companyId !== request.scope.companyId
      || input.operation !== "staging.browser.safe"
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Staging safe operation is outside the authorized acceptance scope"
      );
    }

    const providerOperationId = `staging-safe:${request.id}`;
    const payloadHash = sha256Hex(input.payload);
    const observedAt = this.now().toISOString();

    await this.db.query(
      `INSERT INTO staging_browser_provider_objects
        (provider_operation_id,request_id,job_id,company_id,payload_hash,created_at)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (provider_operation_id) DO NOTHING`,
      [
        providerOperationId,
        request.id,
        request.jobId,
        request.scope.companyId,
        payloadHash,
        observedAt
      ]
    );

    return createBusinessActionAdapterResult({
      source: "business-action-adapter",
      requestId: request.id,
      adapterId: this.id,
      adapterVersion: this.version,
      status: "accepted",
      providerOperationId,
      output: {
        providerOperationId,
        responseStatus: 202,
        responseBodyHash: payloadHash,
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
  }) {
    assertEnabled(this.env);
    const result = await this.db.query<SafeProviderObjectRow>(
      `SELECT provider_operation_id,request_id,job_id,company_id,payload_hash,created_at
       FROM staging_browser_provider_objects
       WHERE provider_operation_id=$1 AND request_id=$2`,
      [input.providerOperationId, input.requestId]
    );
    return createBusinessActionStatus({
      source: "business-action-adapter",
      requestId: input.requestId,
      providerOperationId: input.providerOperationId,
      adapterId: this.id,
      adapterVersion: this.version,
      state: result.rows[0] ? "completed" : "pending",
      observedAt: this.now().toISOString()
    });
  }
}

export function stagingBrowserSafeBinding(
  db: SqlQueryable,
  env: Readonly<Record<string, string | undefined>> = process.env
): BusinessActionAdapterBinding {
  assertEnabled(env);
  return {
    capability: "http.request",
    adapter: new StagingBrowserSafeActionAdapter(db, env)
  };
}
