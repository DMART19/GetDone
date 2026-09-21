import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  BusinessActionExecutionRecord,
  BusinessActionExecutionStore
} from "@/lib/execution/business-action-orchestrator";
import type {
  SoftwareWorkerRuntimeRecord,
  SoftwareWorkerRuntimeStore
} from "@/lib/execution/software-worker-runtime";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";

export class PostgresBusinessActionExecutionStore
  implements BusinessActionExecutionStore {
  constructor(private readonly db: SqlQueryable) {}

  async get(requestId: string) {
    const result = await this.db.query<{ payload: BusinessActionExecutionRecord }>(
      "SELECT payload FROM business_action_executions WHERE request_id=$1",
      [requestId]
    );
    return result.rows[0]?.payload ?? null;
  }

  async save(record: BusinessActionExecutionRecord, expectedRecordHash?: string) {
    if (!expectedRecordHash) {
      const inserted = await this.db.query(
        `INSERT INTO business_action_executions
          (request_id,job_id,adapter_id,provider_operation_id,state,request_hash,record_hash,payload,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
         ON CONFLICT (request_id) DO NOTHING`,
        [
          record.requestId,
          record.jobId,
          record.adapterId,
          record.providerOperationId ?? null,
          record.state,
          record.requestHash,
          record.recordHash,
          JSON.stringify(record),
          record.updatedAt
        ]
      );
      if (inserted.rowCount === 1) return;
      const existing = await this.get(record.requestId);
      if (existing?.recordHash === record.recordHash) return;
      throw new ControlPlaneError("CONFLICT", "Business action execution already exists");
    }

    const updated = await this.db.query(
      `UPDATE business_action_executions
       SET provider_operation_id=$2,state=$3,record_hash=$4,payload=$5::jsonb,updated_at=$6
       WHERE request_id=$1 AND record_hash=$7`,
      [
        record.requestId,
        record.providerOperationId ?? null,
        record.state,
        record.recordHash,
        JSON.stringify(record),
        record.updatedAt,
        expectedRecordHash
      ]
    );
    if (updated.rowCount !== 1) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Business action execution changed before compare-and-swap persistence"
      );
    }
  }
}

export class PostgresSoftwareWorkerRuntimeStore
  implements SoftwareWorkerRuntimeStore {
  constructor(private readonly db: SqlQueryable) {}

  async get(planId: string) {
    const result = await this.db.query<{ payload: SoftwareWorkerRuntimeRecord }>(
      "SELECT payload FROM software_pipeline_records WHERE plan_id=$1",
      [planId]
    );
    return result.rows[0]?.payload ?? null;
  }

  async save(record: SoftwareWorkerRuntimeRecord, expectedRuntimeHash?: string) {
    if (!expectedRuntimeHash) {
      const inserted = await this.db.query(
        `INSERT INTO software_pipeline_records(plan_id,state,record_hash,payload,updated_at)
         VALUES($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT (plan_id) DO NOTHING`,
        [
          record.planId,
          record.pipeline.state,
          record.runtimeHash,
          JSON.stringify(record),
          record.updatedAt
        ]
      );
      if (inserted.rowCount === 1) return;
      const existing = await this.get(record.planId);
      if (existing?.runtimeHash === record.runtimeHash) return;
      throw new ControlPlaneError("CONFLICT", "Software worker runtime already exists");
    }

    const updated = await this.db.query(
      `UPDATE software_pipeline_records
       SET state=$2,record_hash=$3,payload=$4::jsonb,updated_at=$5
       WHERE plan_id=$1 AND record_hash=$6`,
      [
        record.planId,
        record.pipeline.state,
        record.runtimeHash,
        JSON.stringify(record),
        record.updatedAt,
        expectedRuntimeHash
      ]
    );
    if (updated.rowCount !== 1) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Software worker runtime changed before compare-and-swap persistence"
      );
    }
  }
}
