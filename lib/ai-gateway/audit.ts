import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type {
  AICallAuditRecord,
  AIRequestEnvelope,
  AIRouteDecision,
  AIAdapterResponse
} from "@/lib/ai-gateway/contracts";

export function createAICallAuditRecord(input: {
  request: AIRequestEnvelope;
  route: AIRouteDecision;
  estimatedCostCents: number;
  recordedAt: string;
  response?: AIAdapterResponse;
  fallbackUsed?: boolean;
  fallbackReason?: string;
  validationStatus: AICallAuditRecord["validationStatus"];
  failureClass?: string;
}): AICallAuditRecord {
  const base = {
    requestId: input.request.id,
    correlationId: input.request.correlationId,
    portfolioId: input.request.scope.portfolioId,
    companyId: input.request.scope.companyId,
    environment: input.request.scope.environment,
    role: input.request.requirements.role,
    routingPolicyVersion: input.route.routingPolicyVersion,
    selectedProfileId: input.route.selectedProfileId,
    actualProfileId: input.response?.profileId,
    gatewayId: input.response?.gatewayId,
    providerId: input.response?.providerId,
    modelId: input.response?.modelId,
    fallbackUsed: input.fallbackUsed ?? false,
    fallbackReason: input.fallbackReason,
    latencyMs: input.response?.latencyMs,
    inputTokens: input.response?.inputTokens,
    outputTokens: input.response?.outputTokens,
    estimatedCostCents: input.estimatedCostCents,
    validationStatus: input.validationStatus,
    failureClass: input.failureClass,
    recordedAt: input.recordedAt
  };
  return Object.freeze({ ...base, auditHash: sha256Hex(base) });
}
