import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type {
  AICallAuditRecord,
  AIRequestEnvelope,
  AIRouteDecision,
  AIAdapterResponse,
  AIUsageRecord,
  ModelProfile
} from "@/lib/ai-gateway/contracts";

export function actualResponseCostCents(profile: ModelProfile, response: AIAdapterResponse) {
  if (response.providerCostCents !== undefined) {
    return Number(Math.max(0, response.providerCostCents).toFixed(6));
  }
  const input = response.inputTokens / 1_000_000 * profile.inputCostPerMillionTokensCents;
  const output = response.outputTokens / 1_000_000 * profile.outputCostPerMillionTokensCents;
  return Number((input + output).toFixed(6));
}

export function createAIUsageRecord(input: {
  request: AIRequestEnvelope;
  profile: ModelProfile;
  attempt: number;
  estimatedCostCents: number;
  recordedAt: string;
  response?: AIAdapterResponse;
  outcome: AIUsageRecord["outcome"];
  failureClass?: string;
}): AIUsageRecord {
  const response = input.response;
  const base = {
    requestId: input.request.id,
    correlationId: input.request.correlationId,
    portfolioId: input.request.scope.portfolioId,
    companyId: input.request.scope.companyId,
    environment: input.request.scope.environment,
    attempt: input.attempt,
    profileId: input.profile.id,
    gatewayId: response?.gatewayId ?? input.profile.gatewayId,
    providerId: response?.providerId ?? input.profile.providerId,
    modelId: response?.modelId ?? input.profile.modelId,
    inputTokens: response?.inputTokens ?? 0,
    outputTokens: response?.outputTokens ?? 0,
    estimatedCostCents: input.estimatedCostCents,
    actualCostCents: response ? actualResponseCostCents(input.profile, response) : 0,
    latencyMs: response?.latencyMs ?? 0,
    outcome: input.outcome,
    failureClass: input.failureClass,
    recordedAt: input.recordedAt
  };
  return Object.freeze({ ...base, usageHash: sha256Hex(base) });
}

export function createAICallAuditRecord(input: {
  request: AIRequestEnvelope;
  route: AIRouteDecision;
  estimatedCostCents: number;
  actualCostCents?: number;
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
    actualCostCents: input.actualCostCents ?? 0,
    validationStatus: input.validationStatus,
    failureClass: input.failureClass,
    recordedAt: input.recordedAt
  };
  return Object.freeze({ ...base, auditHash: sha256Hex(base) });
}
