import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export const BUSINESS_ACTION_ADAPTER_CONTRACT_VERSION = "1.0.0";

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

export interface BusinessActionAdapterResult {
  source: "business-action-adapter";
  requestId: string;
  adapterId: string;
  adapterVersion: string;
  status: "accepted" | "rejected" | "failed";
  providerOperationId?: string;
  retryable: boolean;
  observedAt: string;
  jobStateMutationApplied: false;
  resultHash: string;
}

export interface BusinessActionStatus {
  requestId: string;
  providerOperationId: string;
  state: "pending" | "running" | "completed" | "failed" | "cancelled";
  observedAt: string;
  jobStateMutationApplied: false;
}

export interface BusinessActionAdapter {
  readonly id: string;
  readonly version: string;
  execute(request: AuthorizedBusinessActionRequest): Promise<BusinessActionAdapterResult>;
  status(input: {
    requestId: string;
    providerOperationId: string;
  }): Promise<BusinessActionStatus>;
  cancel?(input: {
    requestId: string;
    providerOperationId: string;
    reason: string;
  }): Promise<BusinessActionStatus>;
}

export function assertAuthorizedBusinessActionRequest(request: AuthorizedBusinessActionRequest) {
  if (
    !request.authorizationConsumptionHash
    || !request.idempotencyKey
    || !request.capability
    || !request.inputHash
    || request.timeoutMs <= 0
    || !Number.isInteger(request.attempt)
    || request.attempt < 1
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Business action adapter requires authorized, scoped, typed execution lineage"
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
  input: Omit<BusinessActionAdapterResult, "jobStateMutationApplied" | "resultHash">
): BusinessActionAdapterResult {
  if (input.status === "accepted" && !input.providerOperationId) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Accepted adapter result requires a provider operation ID"
    );
  }
  const base = {
    ...input,
    jobStateMutationApplied: false as const
  };
  return Object.freeze({ ...base, resultHash: sha256Hex(base) });
}

export function assertBusinessActionAdapterResult(result: BusinessActionAdapterResult) {
  const { resultHash, ...base } = result;
  if (sha256Hex(base) !== resultHash || result.jobStateMutationApplied !== false) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Business adapter result cannot establish authoritative Job truth"
    );
  }
  return result;
}
