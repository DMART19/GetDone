import type {
  AIGatewayAdapter,
  AIAdapterRequest,
  AIAdapterResponse
} from "@/lib/ai-gateway/contracts";

export class DevelopmentMockAIGatewayAdapter implements AIGatewayAdapter {
  readonly id = "development-mock-ai";
  readonly version = "1.0.0";

  constructor(private readonly responder: (request: AIAdapterRequest) => unknown) {}

  async invoke(request: AIAdapterRequest): Promise<AIAdapterResponse> {
    if (request.requirements.environment !== "development") {
      throw new Error("Development mock AI adapter is DEVELOPMENT-only");
    }
    return {
      profileId: request.profile.id,
      gatewayId: request.profile.gatewayId,
      providerId: request.profile.providerId,
      modelId: request.profile.modelId,
      output: this.responder(request),
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 5,
      observedAt: new Date().toISOString()
    };
  }
}
