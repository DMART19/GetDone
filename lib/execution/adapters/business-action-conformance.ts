import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  AuthorizedBusinessActionRequest,
  BusinessActionAdapter,
  BusinessActionStatus
} from "@/lib/execution/adapters/business-action";
import {
  assertAuthorizedBusinessActionRequest,
  assertBusinessActionAdapterResult,
  assertBusinessActionStatus
} from "@/lib/execution/adapters/business-action";

function assertAdapterStatusIdentity(input: {
  adapter: BusinessActionAdapter;
  request: AuthorizedBusinessActionRequest;
  providerOperationId: string;
  status: BusinessActionStatus;
}) {
  assertBusinessActionStatus(input.status);
  if (
    input.status.adapterId !== input.adapter.id
    || input.status.adapterVersion !== input.adapter.version
    || input.status.requestId !== input.request.id
    || input.status.providerOperationId !== input.providerOperationId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Business adapter status identity does not match the invoked adapter/request"
    );
  }
  return input.status;
}

export async function assertBusinessActionAdapterConformance(input: {
  adapter: BusinessActionAdapter;
  request: AuthorizedBusinessActionRequest;
}) {
  assertAuthorizedBusinessActionRequest(input.request);
  const result = await input.adapter.execute(input.request);
  assertBusinessActionAdapterResult(result);
  if (
    result.adapterId !== input.adapter.id
    || result.adapterVersion !== input.adapter.version
    || result.requestId !== input.request.id
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Business adapter result identity does not match the invoked adapter/request"
    );
  }

  if (result.status === "accepted" && result.providerOperationId) {
    const status = await input.adapter.status({
      requestId: input.request.id,
      providerOperationId: result.providerOperationId
    });
    assertAdapterStatusIdentity({
      adapter: input.adapter,
      request: input.request,
      providerOperationId: result.providerOperationId,
      status
    });
  }

  return result;
}

export async function assertBusinessActionCancelConformance(input: {
  adapter: BusinessActionAdapter;
  request: AuthorizedBusinessActionRequest;
  providerOperationId: string;
  reason: string;
}) {
  if (!input.adapter.cancel) {
    throw new ControlPlaneError("UNAVAILABLE", "Business adapter does not support cancellation");
  }
  const status = await input.adapter.cancel({
    requestId: input.request.id,
    providerOperationId: input.providerOperationId,
    reason: input.reason
  });
  return assertAdapterStatusIdentity({
    adapter: input.adapter,
    request: input.request,
    providerOperationId: input.providerOperationId,
    status
  });
}
