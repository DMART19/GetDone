import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export const BUSINESS_ACTION_ADAPTER_CONTRACT_VERSION = "1.4.0";

export type BusinessActionRetryClass =
  | "none"
  | "transport"
  | "timeout"
  | "rate-limit"
  | "provider-4xx"
  | "provider-5xx"
  | "malformed-response"
  | "verification-pending";

export interface AuthorizedBusinessActionRequest {
  id: string;
  jobId: string;
  scope: TrustedExecutionScope;
  capability: string;
  input: unknown;
  inputHash: string;
  authorizationConsumptionHash: string;
  credentialLeaseId?: string;
  idempotencyKey: string;
  timeoutMs: number;
  attempt: number;
}

export interface BusinessActionCredentialRequirement {
  providerId: string;
  requiredScopes: readonly string[];
}

export interface BusinessActionCredentialMaterial {
  leaseId: string;
  leaseHash: string;
  providerId: string;
  capability: string;
  grantedScopes: readonly string[];
  material: string;
  issuedAt: string;
  expiresAt: string;
}

export interface BusinessActionExecutionContext {
  credential?: BusinessActionCredentialMaterial;
}

export interface BusinessActionAdapterResult {
  source: "business-action-adapter";
  requestId: string;
  adapterId: string;
  adapterVersion: string;
  status: "accepted" | "completed" | "rejected" | "failed";
  providerOperationId?: string;
  output?: unknown;
  outputHash?: string;
  retryable: boolean;
  retryClass?: BusinessActionRetryClass;
  observedAt: string;
  jobStateMutationApplied: false;
  resultHash: string;
}

export interface BusinessActionStatus {
  source: "business-action-adapter";
  requestId: string;
  providerOperationId: string;
  adapterId: string;
  adapterVersion: string;
  state: "pending" | "running" | "completed" | "failed" | "cancelled";
  observedAt: string;
  jobStateMutationApplied: false;
  statusHash: string;
}

export interface BusinessActionAdapter {
  readonly id: string;
  readonly version: string;
  credentialRequirement?(request: AuthorizedBusinessActionRequest): BusinessActionCredentialRequirement | null;
  execute(
    request: AuthorizedBusinessActionRequest,
    context?: BusinessActionExecutionContext
  ): Promise<BusinessActionAdapterResult>;
  status(input: {
    requestId: string;
    providerOperationId: string;
  }, context?: BusinessActionExecutionContext): Promise<BusinessActionStatus>;
  cancel?(input: {
    requestId: string;
    providerOperationId: string;
    reason: string;
  }, context?: BusinessActionExecutionContext): Promise<BusinessActionStatus>;
}

function assertTimestamp(value: string, label: string) {
  if (!Number.isFinite(Date.parse(value))) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
}

export function assertAuthorizedBusinessActionRequest(request: AuthorizedBusinessActionRequest) {
  if (
    !request.authorizationConsumptionHash
    || !request.idempotencyKey
    || !request.capability
    || !request.inputHash
    || !Number.isInteger(request.timeoutMs)
    || request.timeoutMs <= 0
    || !Number.isInteger(request.attempt)
    || request.attempt < 1
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Business action adapter requires authorized, scoped, typed execution lineage"
    );
  }
  if (sha256Hex(request.input) !== request.inputHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Business action input hash does not match the authorized payload"
    );
  }
  if (request.scope.environment === "production" && !request.credentialLeaseId) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Production business actions require a scoped credential lease reference"
    );
  }
  return request;
}

export function createBusinessActionAdapterResult(
  input: Omit<BusinessActionAdapterResult, "jobStateMutationApplied" | "resultHash" | "outputHash">
): BusinessActionAdapterResult {
  if (input.status === "accepted" && !input.providerOperationId) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Accepted adapter result requires a provider operation ID"
    );
  }
  if (input.retryClass === "none" && input.retryable) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "retryClass none cannot be marked retryable"
    );
  }
  if (input.status === "completed" && input.output === undefined) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Completed adapter result requires typed output"
    );
  }
  assertTimestamp(input.observedAt, "business action observedAt");
  const base = {
    ...input,
    outputHash: input.output === undefined ? undefined : sha256Hex(input.output),
    jobStateMutationApplied: false as const
  };
  return Object.freeze({ ...base, resultHash: sha256Hex(base) });
}

export function assertBusinessActionAdapterResult(result: BusinessActionAdapterResult) {
  const { resultHash, ...base } = result;
  if (
    sha256Hex(base) !== resultHash
    || result.source !== "business-action-adapter"
    || result.jobStateMutationApplied !== false
    || (result.status === "accepted" && !result.providerOperationId)
    || (result.output !== undefined && result.outputHash !== sha256Hex(result.output))
    || (result.status === "completed" && result.output === undefined)
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Business adapter result cannot establish authoritative Job truth"
    );
  }
  assertTimestamp(result.observedAt, "business action result observedAt");
  return result;
}

export function createBusinessActionStatus(
  input: Omit<BusinessActionStatus, "jobStateMutationApplied" | "statusHash">
): BusinessActionStatus {
  assertTimestamp(input.observedAt, "business action status observedAt");
  if (!input.providerOperationId) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Business action status requires provider operation lineage"
    );
  }
  const base = {
    ...input,
    jobStateMutationApplied: false as const
  };
  return Object.freeze({ ...base, statusHash: sha256Hex(base) });
}

export function assertBusinessActionStatus(status: BusinessActionStatus) {
  const { statusHash, ...base } = status;
  if (
    sha256Hex(base) !== statusHash
    || status.source !== "business-action-adapter"
    || status.jobStateMutationApplied !== false
    || !status.providerOperationId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Business adapter status is invalid or attempts to establish authoritative Job truth"
    );
  }
  assertTimestamp(status.observedAt, "business action status observedAt");
  return status;
}
