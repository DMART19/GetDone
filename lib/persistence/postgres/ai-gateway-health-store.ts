import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { AIBudgetSnapshot } from "@/lib/ai-gateway/contracts";
import {
  budgetEvidenceFromSnapshot,
  type AIGatewayHealthEvidence,
  type AIGatewayHealthEvidenceReader
} from "@/lib/ai-gateway/health";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";

interface CanaryRow {
  observed_at: Date | string;
}

interface ErrorRow {
  failure_class: string | null;
}

interface BudgetRow {
  period: string;
  company_remaining_cents: string | number;
  portfolio_remaining_cents: string | number;
  active_concurrent_calls: number;
  concurrency_limit: number;
  snapshot_at: Date | string;
  expires_at: Date | string;
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function finiteNumber(value: string | number) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

export class PostgresAIGatewayHealthStore implements AIGatewayHealthEvidenceReader {
  constructor(private readonly db: SqlQueryable) {}

  async recordSuccessfulCanary(input: {
    environment: TrustedExecutionScope["environment"];
    routingPolicyVersion: string;
    observedAt: string;
    latencyMs: number;
  }) {
    const payload = {
      environment: input.environment,
      routingPolicyVersion: input.routingPolicyVersion,
      status: "success",
      observedAt: input.observedAt,
      latencyMs: input.latencyMs
    };
    const evidenceHash = sha256Hex(payload);
    await this.db.query(
      `INSERT INTO ai_gateway_canary_events
        (id,environment,routing_policy_version,status,latency_ms,observed_at,evidence_hash,payload)
       VALUES($1,$2,$3,'success',$4,$5,$6,$7::jsonb)
       ON CONFLICT (evidence_hash) DO NOTHING`,
      [
        `canary:${evidenceHash}`,
        input.environment,
        input.routingPolicyVersion,
        input.latencyMs,
        input.observedAt,
        evidenceHash,
        JSON.stringify(payload)
      ]
    );
  }

  async recordBudgetSnapshot(snapshot: AIBudgetSnapshot, recordedAt: string) {
    const payload = {
      portfolioId: snapshot.portfolioId,
      companyId: snapshot.companyId,
      period: snapshot.period,
      companyRemainingCents: snapshot.companyRemainingCents,
      portfolioRemainingCents: snapshot.portfolioRemainingCents,
      activeConcurrentCalls: snapshot.activeConcurrentCalls,
      concurrencyLimit: snapshot.concurrencyLimit,
      snapshotAt: snapshot.snapshotAt,
      expiresAt: snapshot.expiresAt,
      recordedAt
    };
    const snapshotHash = sha256Hex(payload);
    await this.db.query(
      `INSERT INTO ai_budget_health_snapshots
        (snapshot_hash,portfolio_id,company_id,period,company_remaining_cents,
         portfolio_remaining_cents,active_concurrent_calls,concurrency_limit,
         snapshot_at,expires_at,recorded_at,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       ON CONFLICT (snapshot_hash) DO NOTHING`,
      [
        snapshotHash,
        snapshot.portfolioId,
        snapshot.companyId,
        snapshot.period,
        snapshot.companyRemainingCents,
        snapshot.portfolioRemainingCents,
        snapshot.activeConcurrentCalls,
        snapshot.concurrencyLimit,
        snapshot.snapshotAt,
        snapshot.expiresAt,
        recordedAt,
        JSON.stringify(payload)
      ]
    );
  }

  async read(
    scope: TrustedExecutionScope,
    environment: TrustedExecutionScope["environment"],
    now = new Date()
  ): Promise<AIGatewayHealthEvidence> {
    const [canary, error, budget] = await Promise.all([
      this.db.query<CanaryRow>(
        `SELECT observed_at
         FROM ai_gateway_canary_events
         WHERE environment=$1 AND status='success'
         ORDER BY observed_at DESC
         LIMIT 1`,
        [environment]
      ),
      this.db.query<ErrorRow>(
        `SELECT NULLIF(payload->>'failureClass','') AS failure_class
         FROM ai_call_audits
         WHERE portfolio_id=$1
           AND company_id=$2
           AND NULLIF(payload->>'failureClass','') IS NOT NULL
         ORDER BY recorded_at DESC
         LIMIT 1`,
        [scope.portfolioId, scope.companyId]
      ),
      this.db.query<BudgetRow>(
        `SELECT period,company_remaining_cents,portfolio_remaining_cents,
                active_concurrent_calls,concurrency_limit,snapshot_at,expires_at
         FROM ai_budget_health_snapshots
         WHERE portfolio_id=$1 AND company_id=$2
         ORDER BY recorded_at DESC
         LIMIT 1`,
        [scope.portfolioId, scope.companyId]
      )
    ]);

    const budgetRow = budget.rows[0];
    const budgetSnapshot: AIBudgetSnapshot | null = budgetRow
      ? {
          portfolioId: scope.portfolioId,
          companyId: scope.companyId,
          period: budgetRow.period,
          companyRemainingCents: finiteNumber(budgetRow.company_remaining_cents),
          portfolioRemainingCents: finiteNumber(budgetRow.portfolio_remaining_cents),
          activeConcurrentCalls: budgetRow.active_concurrent_calls,
          concurrencyLimit: budgetRow.concurrency_limit,
          snapshotAt: iso(budgetRow.snapshot_at),
          expiresAt: iso(budgetRow.expires_at)
        }
      : null;

    return {
      lastSuccessfulCanaryAt: canary.rows[0]
        ? iso(canary.rows[0].observed_at)
        : null,
      recentErrorClass: error.rows[0]?.failure_class ?? null,
      budget: budgetEvidenceFromSnapshot(budgetSnapshot, now)
    };
  }
}
