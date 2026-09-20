import {
  assertAuthorizedBusinessActionRequest,
  createBusinessActionAdapterResult,
  type AuthorizedBusinessActionRequest,
  type BusinessActionAdapter,
  type BusinessActionAdapterResult,
  type BusinessActionStatus
} from "@/lib/execution/adapters/business-action";

export class DevelopmentMockBusinessActionAdapter implements BusinessActionAdapter {
  readonly id = "development-mock-business-action";
  readonly version = "1.0.0";

  async execute(request: AuthorizedBusinessActionRequest): Promise<BusinessActionAdapterResult> {
    assertAuthorizedBusinessActionRequest(request);
    if (request.scope.environment !== "development") {
      throw new Error("Development mock business action adapter is DEVELOPMENT-only");
    }
    return createBusinessActionAdapterResult({
      source: "business-action-adapter",
      requestId: request.id,
      adapterId: this.id,
      adapterVersion: this.version,
      status: "accepted",
      providerOperationId: `mock-operation:${request.id}`,
      retryable: false,
      observedAt: new Date().toISOString()
    });
  }

  async status(input: { requestId: string; providerOperationId: string }): Promise<BusinessActionStatus> {
    return {
      requestId: input.requestId,
      providerOperationId: input.providerOperationId,
      state: "completed",
      observedAt: new Date().toISOString(),
      jobStateMutationApplied: false
    };
  }
}
