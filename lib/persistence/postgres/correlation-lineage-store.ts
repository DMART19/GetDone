import type { SqlQueryable } from "@/lib/persistence/postgres/client";
import {
  reconstructExecutionByCorrelationId,
  type CorrelationArtifact,
  type CorrelationStage
} from "@/lib/observability/correlation-lineage";

interface Row {
  stage: CorrelationStage;
  id: string;
  occurred_at: Date | string | null;
  entity_type: string | null;
  payload: unknown;
}

function iso(value: Date | string | null) {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

export class PostgresCorrelationLineageStore {
  constructor(private readonly db: SqlQueryable) {}

  async reconstruct(correlationId: string) {
    const result = await this.db.query<Row>(
      `WITH correlated AS (
        SELECT 'owner-request'::text AS stage, id, received_at AS occurred_at,
               'owner-intent'::text AS entity_type, payload
        FROM owner_intents
        WHERE payload->>'correlationId'=$1

        UNION ALL
        SELECT CASE entity_type
                 WHEN 'decision' THEN 'decision'
                 WHEN 'plan' THEN 'plan'
                 WHEN 'task' THEN 'task'
                 WHEN 'job' THEN 'job'
                 ELSE 'audit'
               END AS stage,
               id, updated_at AS occurred_at, entity_type, payload
        FROM control_plane_entities
        WHERE payload->>'correlationId'=$1
          AND entity_type IN ('decision','plan','task','job')

        UNION ALL
        SELECT 'queue', job_id, updated_at, 'job-runtime', envelope
        FROM job_runtime_state
        WHERE envelope->>'correlationId'=$1

        UNION ALL
        SELECT 'worker', l.id, r.updated_at, 'job-lease', l.payload
        FROM job_leases l
        JOIN job_runtime_state r ON r.job_id=l.job_id
        WHERE r.envelope->>'correlationId'=$1

        UNION ALL
        SELECT 'provider', request_id, updated_at, 'business-action', payload
        FROM business_action_executions
        WHERE payload->>'correlationId'=$1

        UNION ALL
        SELECT 'verification', evidence_id, observed_at, 'verification-evidence', payload
        FROM business_action_verification_evidence
        WHERE payload->>'correlationId'=$1

        UNION ALL
        SELECT 'audit', id, occurred_at, entity_type, payload
        FROM audit_events
        WHERE correlation_id=$1

        UNION ALL
        SELECT 'owner-result', e.id, e.updated_at, 'job-result', e.payload
        FROM control_plane_entities e
        WHERE e.entity_type='job' AND e.payload->>'correlationId'=$1
      )
      SELECT stage,id,occurred_at,entity_type,payload
      FROM correlated
      ORDER BY occurred_at NULLS LAST, stage, id`,
      [correlationId]
    );

    const artifacts: CorrelationArtifact[] = result.rows.map((row) => ({
      stage: row.stage,
      correlationId,
      id: row.id,
      occurredAt: iso(row.occurred_at),
      entityType: row.entity_type ?? undefined,
      payload: row.payload
    }));

    return reconstructExecutionByCorrelationId(correlationId, artifacts);
  }
}
