import type {
  AICallAuditRecord,
  AICallAuditStore,
  AIUsageRecord,
  AIBudgetSnapshot
} from "@/lib/ai-gateway/contracts";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";
import { PostgresAIGatewayHealthStore } from "@/lib/persistence/postgres/ai-gateway-health-store";

export class PostgresAICallAuditStore implements AICallAuditStore {
  private readonly health: PostgresAIGatewayHealthStore;

  constructor(private readonly db: SqlQueryable) {
    this.health = new PostgresAIGatewayHealthStore(db);
  }

  async appendAudit(record: AICallAuditRecord) {
    await this.db.query(
      `INSERT INTO ai_call_audits
        (request_id,correlation_id,portfolio_id,company_id,validation_status,
         estimated_cost_cents,actual_cost_cents,audit_hash,payload,recorded_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
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
        record.recordedAt
      ]
    );
  }

  async recordBudgetSnapshot(snapshot: AIBudgetSnapshot, recordedAt: string) {
    await this.health.recordBudgetSnapshot(snapshot, recordedAt);
  }

  async appendUsage(record: AIUsageRecord) {
    await this.db.query(
      `INSERT INTO ai_usage_records
        (usage_hash,request_id,attempt,profile_id,gateway_id,provider_id,model_id,
         input_tokens,output_tokens,estimated_cost_cents,actual_cost_cents,outcome,payload,recorded_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
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
        record.recordedAt
      ]
    );
  }
}
