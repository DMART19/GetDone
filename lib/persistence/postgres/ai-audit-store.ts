import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type {
  AICallAuditRecord,
  AICallAuditStore,
  AIUsageRecord,
  ModelProfile,
  ModelRoutePolicy
} from "@/lib/ai-gateway/contracts";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";

export class PostgresAICallAuditStore implements AICallAuditStore {
  constructor(private readonly db: SqlQueryable) {}

  async appendAudit(record: AICallAuditRecord) {
    await this.db.query(
      `INSERT INTO ai_call_audits
        (request_id,correlation_id,portfolio_id,company_id,validation_status,
         estimated_cost_cents,actual_cost_cents,audit_hash,payload,recorded_at,
         routing_policy_version,selected_profile_id,actual_profile_id,gateway_id,
         provider_id,model_id,fallback_used,fallback_reason,latency_ms,input_tokens,
         output_tokens,failure_class)
       VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,
         $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
       )
       ON CONFLICT (audit_hash) DO NOTHING`,
      [
        record.requestId,
        record.correlationId,
        record.portfolioId,
        record.companyId,
        record.validationStatus,
        record.estimatedCostCents,
        record.actualCostCents,
        record.auditHash,
        JSON.stringify(record),
        record.recordedAt,
        record.routingPolicyVersion,
        record.selectedProfileId ?? null,
        record.actualProfileId ?? null,
        record.gatewayId ?? null,
        record.providerId ?? null,
        record.modelId ?? null,
        record.fallbackUsed,
        record.fallbackReason ?? null,
        record.latencyMs ?? null,
        record.inputTokens ?? null,
        record.outputTokens ?? null,
        record.failureClass ?? null
      ]
    );
  }

  async appendUsage(record: AIUsageRecord) {
    await this.db.query(
      `INSERT INTO ai_usage_records
        (usage_hash,request_id,attempt,profile_id,gateway_id,provider_id,model_id,
         input_tokens,output_tokens,estimated_cost_cents,actual_cost_cents,outcome,
         payload,recorded_at,correlation_id,portfolio_id,company_id,environment,
         latency_ms,failure_class)
       VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,
         $15,$16,$17,$18,$19,$20
       )
       ON CONFLICT (usage_hash) DO NOTHING`,
      [
        record.usageHash,
        record.requestId,
        record.attempt,
        record.profileId,
        record.gatewayId,
        record.providerId,
        record.modelId,
        record.inputTokens,
        record.outputTokens,
        record.estimatedCostCents,
        record.actualCostCents,
        record.outcome,
        JSON.stringify(record),
        record.recordedAt,
        record.correlationId,
        record.portfolioId,
        record.companyId,
        record.environment,
        record.latencyMs,
        record.failureClass ?? null
      ]
    );
  }
}

export interface AIGatewayRuntimeConfigEvidence {
  configVersion: string;
  routingPolicyVersion: string;
  providerId: string;
  profiles: readonly ModelProfile[];
  policy: ModelRoutePolicy;
  recordedAt: string;
  configHash: string;
}

export function createAIGatewayRuntimeConfigEvidence(input: {
  configVersion: string;
  routingPolicyVersion: string;
  providerId: string;
  profiles: readonly ModelProfile[];
  policy: ModelRoutePolicy;
  recordedAt: string;
}): AIGatewayRuntimeConfigEvidence {
  const base = {
    configVersion: input.configVersion,
    routingPolicyVersion: input.routingPolicyVersion,
    providerId: input.providerId,
    profiles: input.profiles,
    policy: input.policy,
    recordedAt: input.recordedAt
  };
  return Object.freeze({ ...base, configHash: sha256Hex(base) });
}

export interface AIGatewayCanaryEvidence {
  canaryId: string;
  configHash: string;
  gatewayId: string;
  providerId: string;
  modelId: string;
  ok: true;
  latencyMs: number;
  observedAt: string;
  evidenceHash: string;
}

export function createAIGatewayCanaryEvidence(input: Omit<AIGatewayCanaryEvidence, "evidenceHash">) {
  return Object.freeze({ ...input, evidenceHash: sha256Hex(input) });
}

export class PostgresAIGatewayEvidenceStore {
  constructor(private readonly db: SqlQueryable) {}

  async putConfig(record: AIGatewayRuntimeConfigEvidence) {
    await this.db.query(
      `INSERT INTO ai_gateway_runtime_configs
        (config_hash,config_version,routing_policy_version,provider_id,payload,recorded_at)
       VALUES($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT (config_hash) DO NOTHING`,
      [
        record.configHash,
        record.configVersion,
        record.routingPolicyVersion,
        record.providerId,
        JSON.stringify(record),
        record.recordedAt
      ]
    );
  }

  async putCanary(record: AIGatewayCanaryEvidence) {
    await this.db.query(
      `INSERT INTO ai_gateway_canary_runs
        (evidence_hash,canary_id,config_hash,gateway_id,provider_id,model_id,
         ok,latency_ms,observed_at,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (evidence_hash) DO NOTHING`,
      [
        record.evidenceHash,
        record.canaryId,
        record.configHash,
        record.gatewayId,
        record.providerId,
        record.modelId,
        record.ok,
        record.latencyMs,
        record.observedAt,
        JSON.stringify(record)
      ]
    );
  }
}
