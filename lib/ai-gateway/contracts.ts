import type { ZodType } from "zod";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { ResourceDataClass } from "@/lib/resources/policy";

export const AI_GATEWAY_CONTRACT_VERSION = "1.3.0";
export const AI_ROUTING_POLICY_CONTRACT_VERSION = "1.0.0";

export type AIRole =
  | "DETERMINISTIC"
  | "LIGHTWEIGHT"
  | "STANDARD"
  | "HIGH_REASONING"
  | "CODING"
  | "VISION"
  | "LONG_CONTEXT";

export type AIModality = "text" | "image";
export type AILatencyClass = "low" | "standard" | "high";
export type ModelValidationStatus = "validated" | "unvalidated" | "failed";
export type ModelHealth = "healthy" | "degraded" | "disabled";

export interface AIRequirementEnvelope {
  role: AIRole;
  requiredModalities: readonly AIModality[];
  requiresTools: boolean;
  requiresStructuredOutput: boolean;
  minimumContextTokens: number;
  estimatedInputTokens: number;
  expectedOutputTokens: number;
  dataClass: ResourceDataClass;
  environment: TrustedExecutionScope["environment"];
  latencyClass: AILatencyClass;
  maxCostCents: number;
  allowFallback: boolean;
  excludedProfileIds?: readonly string[];
  pinnedProfileIds?: readonly string[];
}

export interface ModelProfile {
  id: string;
  gatewayId: string;
  providerId: string;
  modelId: string;
  enabled: boolean;
  validationStatus: ModelValidationStatus;
  roles: readonly Exclude<AIRole, "DETERMINISTIC">[];
  modalities: readonly AIModality[];
  supportsTools: boolean;
  supportsStructuredOutput: boolean;
  maxContextTokens: number;
  allowedDataClasses: readonly ResourceDataClass[];
  allowedEnvironments: readonly TrustedExecutionScope["environment"][];
  health: ModelHealth;
  latencyClass: AILatencyClass;
  inputCostPerMillionTokensCents: number;
  outputCostPerMillionTokensCents: number;
  profileVersion: string;
}

export interface ModelRoutePolicy {
  version: string;
  routes: Readonly<Partial<Record<Exclude<AIRole, "DETERMINISTIC">, readonly string[]>>>;
}

export interface AIRequestEnvelope {
  id: string;
  correlationId: string;
  scope: TrustedExecutionScope;
  requirements: AIRequirementEnvelope;
  inputHash: string;
  requestedAt: string;
}

export interface ModelEligibilityResult {
  profileId: string;
  eligible: boolean;
  rejectionReasons: readonly string[];
  estimatedCostCents: number;
}

export interface AIRouteDecision {
  requestId: string;
  routingPolicyVersion: string;
  kind: "deterministic" | "model" | "no-eligible-model";
  selectedProfileId?: string;
  fallbackProfileIds: readonly string[];
  eligibleProfileIds: readonly string[];
  rejected: Readonly<Record<string, readonly string[]>>;
  decidedAt: string;
  decisionHash: string;
}

export interface AIBudgetSnapshot {
  portfolioId: string;
  companyId: string;
  period: string;
  companyRemainingCents: number;
  portfolioRemainingCents: number;
  activeConcurrentCalls: number;
  concurrencyLimit: number;
  snapshotAt: string;
  expiresAt: string;
}

export interface AIBudgetAdmission {
  requestId: string;
  estimatedMaxCostCents: number;
  admitted: true;
  admittedAt: string;
  budgetHash: string;
}

export interface AIAdapterRequest {
  requestId: string;
  correlationId: string;
  profile: ModelProfile;
  input: unknown;
  requirements: AIRequirementEnvelope;
}

export interface AIAdapterResponse {
  profileId: string;
  gatewayId: string;
  providerId: string;
  modelId: string;
  output: unknown;
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported charge when available. The gateway computes a profile-rate fallback otherwise. */
  providerCostCents?: number;
  latencyMs: number;
  observedAt: string;
}

export interface AIGatewayAdapter {
  readonly id: string;
  readonly version: string;
  invoke(request: AIAdapterRequest): Promise<AIAdapterResponse>;
}

export interface AICallAuditRecord {
  requestId: string;
  correlationId: string;
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  role: AIRole;
  routingPolicyVersion: string;
  selectedProfileId?: string;
  actualProfileId?: string;
  gatewayId?: string;
  providerId?: string;
  modelId?: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostCents: number;
  actualCostCents: number;
  validationStatus: "not-called" | "valid" | "invalid" | "failed";
  failureClass?: string;
  recordedAt: string;
  auditHash: string;
}

export interface AIUsageRecord {
  requestId: string;
  correlationId: string;
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  attempt: number;
  profileId: string;
  gatewayId: string;
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostCents: number;
  actualCostCents: number;
  latencyMs: number;
  outcome: "valid" | "schema-invalid" | "identity-mismatch" | "failed";
  failureClass?: string;
  recordedAt: string;
  usageHash: string;
}

export interface AICallAuditStore {
  appendAudit(record: AICallAuditRecord): Promise<void>;
  appendUsage(record: AIUsageRecord): Promise<void>;
  recordBudgetSnapshot?(snapshot: AIBudgetSnapshot, recordedAt: string): Promise<void>;
}

export interface AIInvocationSuccess<T> {
  kind: "success";
  output: T;
  route: AIRouteDecision;
  audit: AICallAuditRecord;
}

export type AIInvocationFailureReason =
  | "NO_ELIGIBLE_MODEL"
  | "ADAPTER_UNAVAILABLE"
  | "MODEL_CALL_FAILED"
  | "MODEL_IDENTITY_MISMATCH"
  | "SCHEMA_INVALID";

export interface AIInvocationUnavailable {
  kind: "unavailable";
  reason: AIInvocationFailureReason;
  route: AIRouteDecision;
  audit: AICallAuditRecord;
}

export type AIInvocationResult<T> = AIInvocationSuccess<T> | AIInvocationUnavailable;

export type AIOutputSchema<T> = ZodType<T>;
