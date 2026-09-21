import {
  assertAuthorizedBusinessActionRequest,
  createBusinessActionAdapterResult,
  createBusinessActionStatus,
  type AuthorizedBusinessActionRequest,
  type BusinessActionAdapter,
  type BusinessActionAdapterResult,
  type BusinessActionStatus
} from "@/lib/execution/adapters/business-action";

export class DevelopmentMockBusinessActionAdapter implements BusinessActionAdapter {
  readonly id = "development-mock-business-action";
  readonly version = "1.1.0";
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

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
      observedAt: this.now().toISOString()
    });
  }

  async status(input: {
    requestId: string;
    providerOperationId: string;
  }): Promise<BusinessActionStatus> {
    return createBusinessActionStatus({
      source: "business-action-adapter",
      requestId: input.requestId,
      providerOperationId: input.providerOperationId,
      adapterId: this.id,
      adapterVersion: this.version,
      state: "completed",
      observedAt: this.now().toISOString()
    });
  }

  async cancel(input: {
    requestId: string;
    providerOperationId: string;
    reason: string;
  }): Promise<BusinessActionStatus> {
    if (!input.reason.trim()) {
      throw new Error("Cancellation reason is required");
    }
    return createBusinessActionStatus({
      source: "business-action-adapter",
      requestId: input.requestId,
      providerOperationId: input.providerOperationId,
      adapterId: this.id,
      adapterVersion: this.version,
      state: "cancelled",
      observedAt: this.now().toISOString()
    });
  }
}
