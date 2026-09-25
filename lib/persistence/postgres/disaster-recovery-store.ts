import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { BusinessActionExecutionRecord } from "@/lib/execution/business-action-orchestrator";
import {
  classifyDisasterRecoveryJob,
  type DisasterRecoveryClassification,
  type DisasterRecoveryDecision
} from "@/lib/execution/disaster-recovery";
import type { PersistedJobExecutionSpec } from "@/lib/execution/job-execution-router";
import type { DurableJobRuntimeSnapshot } from "@/lib/persistence/postgres/job-store";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

interface RuntimeRow {
  job_id: string;
  envelope: DurableJobRuntimeSnapshot["envelope"];
  envelope_hash: string;
  runtime_state: DurableJobRuntimeSnapshot["state"];
  version: number;
  state_hash: string;
  attempt: number;
  scheduled_at: Date | string;
  cancelled_reason: string | null;
  spec_payload: PersistedJobExecutionSpec | null;
  business_payload: BusinessActionExecutionRecord | null;
}

export interface DisasterRecoveryIncidentInput {
  id: string;
  declaredAt: string;
  lostPrimaryAt: string;
  sourceBackupSha256: string;
  sourceSnapshotHash: string;
}

export interface DisasterRecoveryJobDecisionRecord extends DisasterRecoveryClassification {
  incidentId: string;
  jobId: string;
  portfolioId: string;
  companyId: string;
  runtimeState: DurableJobRuntimeSnapshot["state"];
  decidedAt: string;
  decisionHash: string;
}

export interface DisasterRecoveryPlanReport {
  incidentId: string;
  decisions: readonly DisasterRecoveryJobDecisionRecord[];
  counts: Readonly<Record<DisasterRecoveryDecision, number>>;
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function incidentPayload(input: DisasterRecoveryIncidentInput) {
  return {
    id: input.id,
    declaredAt: new Date(input.declaredAt).toISOString(),
    lostPrimaryAt: new Date(input.lostPrimaryAt).toISOString(),
    sourceBackupSha256: input.sourceBackupSha256,
    sourceSnapshotHash: input.sourceSnapshotHash,
    status: "active" as const
  };
}

function runtime(row: RuntimeRow): DurableJobRuntimeSnapshot {
  return {
    envelope: row.envelope,
    version: row.version,
    stateHash: row.state_hash,
    attempt: row.attempt,
    state: row.runtime_state,
    scheduledAt: iso(row.scheduled_at),
    cancelledReason: row.cancelled_reason ?? undefined
  };
}

export class PostgresDisasterRecoveryPlanner {
  constructor(private readonly database: PostgresTransactionalDatabase) {}

  async declareIncident(input: DisasterRecoveryIncidentInput) {
    const payload = incidentPayload(input);
    if (
      !input.id.trim()
      || !Number.isFinite(Date.parse(input.declaredAt))
      || !Number.isFinite(Date.parse(input.lostPrimaryAt))
      || !/^[a-f0-9]{64}$/.test(input.sourceBackupSha256)
      || !/^[a-f0-9]{64}$/.test(input.sourceSnapshotHash)
    ) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Disaster recovery incident input is invalid");
    }
    const incidentHash = sha256Hex(payload);
    const result = await this.database.query(
      `INSERT INTO disaster_recovery_incidents
        (id,declared_at,lost_primary_at,source_backup_sha256,source_snapshot_hash,status,incident_hash,payload)
       VALUES($1,$2,$3,$4,$5,'active',$6,$7::jsonb)
       ON CONFLICT(id) DO NOTHING`,
      [
        input.id,
        payload.declaredAt,
        payload.lostPrimaryAt,
        input.sourceBackupSha256,
        input.sourceSnapshotHash,
        incidentHash,
        JSON.stringify(payload)
      ]
    );
    if (result.rowCount === 1) return { ...payload, incidentHash };

    const existing = await this.database.query<{ incident_hash: string; payload: typeof payload }>(
      "SELECT incident_hash,payload FROM disaster_recovery_incidents WHERE id=$1",
      [input.id]
    );
    if (existing.rows[0]?.incident_hash !== incidentHash) {
      throw new ControlPlaneError("IDEMPOTENCY_CONFLICT", "Disaster recovery incident ID was reused with different evidence");
    }
    return { ...existing.rows[0].payload, incidentHash };
  }

  async planIncident(incidentId: string, decidedAt = new Date().toISOString()): Promise<DisasterRecoveryPlanReport> {
    if (!incidentId.trim() || !Number.isFinite(Date.parse(decidedAt))) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Disaster recovery planning input is invalid");
    }

    return this.database.transaction(async (db) => {
      const incident = await db.query<{ status: string }>(
        "SELECT status FROM disaster_recovery_incidents WHERE id=$1 FOR UPDATE",
        [incidentId]
      );
      if (!incident.rows[0]) {
        throw new ControlPlaneError("NOT_FOUND", "Disaster recovery incident was not declared");
      }
      if (incident.rows[0].status !== "active") {
        throw new ControlPlaneError("CONFLICT", "Disaster recovery incident is not active");
      }

      const result = await db.query<RuntimeRow>(
        `SELECT
           r.job_id,r.envelope,r.envelope_hash,r.runtime_state,r.version,r.state_hash,
           r.attempt,r.scheduled_at,r.cancelled_reason,
           s.payload AS spec_payload,
           b.payload AS business_payload
         FROM job_runtime_state r
         LEFT JOIN job_execution_specs s ON s.job_id=r.job_id
         LEFT JOIN LATERAL (
           SELECT payload
           FROM business_action_executions
           WHERE job_id=r.job_id
           ORDER BY updated_at DESC,request_id DESC
           LIMIT 1
         ) b ON true
         ORDER BY r.job_id
         FOR UPDATE OF r`
      );

      const decisions: DisasterRecoveryJobDecisionRecord[] = [];
      for (const row of result.rows) {
        const current = runtime(row);
        const classification = classifyDisasterRecoveryJob({
          runtime: current,
          spec: row.spec_payload,
          businessExecution: row.business_payload
        });
        const payload = {
          incidentId,
          jobId: row.job_id,
          portfolioId: current.envelope.scope.portfolioId,
          companyId: current.envelope.scope.companyId,
          runtimeState: current.state,
          decidedAt: new Date(decidedAt).toISOString(),
          ...classification
        };
        const decisionHash = sha256Hex(payload);

        await db.query(
          `INSERT INTO job_disaster_recovery_decisions
            (incident_id,job_id,portfolio_id,company_id,decision,reason_code,runtime_state,
             runtime_hash,spec_hash,provider_record_hash,decided_at,decision_hash,payload)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
           ON CONFLICT(incident_id,job_id) DO NOTHING`,
          [
            incidentId,
            row.job_id,
            current.envelope.scope.portfolioId,
            current.envelope.scope.companyId,
            classification.decision,
            classification.reasonCode,
            current.state,
            classification.runtimeHash,
            classification.specHash ?? null,
            classification.providerRecordHash ?? null,
            payload.decidedAt,
            decisionHash,
            JSON.stringify(payload)
          ]
        );

        const persisted = await db.query<{ decision_hash: string }>(
          `SELECT decision_hash FROM job_disaster_recovery_decisions
           WHERE incident_id=$1 AND job_id=$2`,
          [incidentId, row.job_id]
        );
        if (persisted.rows[0]?.decision_hash !== decisionHash) {
          throw new ControlPlaneError("IDEMPOTENCY_CONFLICT", "Persisted disaster recovery decision drifted");
        }
        decisions.push(Object.freeze({ ...payload, decisionHash }));
      }

      const counts = Object.freeze({
        resume: decisions.filter((item) => item.decision === "resume").length,
        reconcile: decisions.filter((item) => item.decision === "reconcile").length,
        blocked: decisions.filter((item) => item.decision === "blocked").length
      });

      return Object.freeze({
        incidentId,
        decisions: Object.freeze(decisions),
        counts
      });
    });
  }

  async clearReconciliation(input: {
    incidentId: string;
    jobId: string;
    clearedAt: string;
    evidenceHash: string;
  }) {
    if (!/^[a-f0-9]{64}$/.test(input.evidenceHash) || !Number.isFinite(Date.parse(input.clearedAt))) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Reconciliation clearance evidence is invalid");
    }
    const result = await this.database.query(
      `UPDATE job_disaster_recovery_decisions
       SET cleared_at=$3,clearance_evidence_hash=$4
       WHERE incident_id=$1 AND job_id=$2 AND decision='reconcile' AND cleared_at IS NULL`,
      [input.incidentId,input.jobId,new Date(input.clearedAt).toISOString(),input.evidenceHash]
    );
    if (result.rowCount !== 1) {
      throw new ControlPlaneError("CONFLICT", "Disaster recovery reconciliation hold was not clearable");
    }
  }
}
