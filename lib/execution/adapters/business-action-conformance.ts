import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  AuthorizedBusinessActionRequest,
  BusinessActionAdapter
} from "@/lib/execution/adapters/business-action";
import { assertBusinessActionAdapterResult } from "@/lib/execution/adapters/business-action";

export async function assertBusinessActionAdapterConformance(input: {
  adapter: BusinessActionAdapter;
  request: AuthorizedBusinessActionRequest;
}) {
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
  return result;
}
