import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  JobExecutionSpecStore,
  PersistedJobExecutionSpec
} from "@/lib/execution/job-execution-router";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";

export class PostgresJobExecutionSpecStore implements JobExecutionSpecStore {
  constructor(private readonly db: SqlQueryable) {}

  async get(jobId: string) {
    const result = await this.db.query<{ payload: PersistedJobExecutionSpec }>(
      "SELECT payload FROM job_execution_specs WHERE job_id=$1",
      [jobId]
    );
    return result.rows[0]?.payload ?? null;
  }

  async put(record: PersistedJobExecutionSpec) {
    const result = await this.db.query(
      `INSERT INTO job_execution_specs(job_id,spec_hash,payload,created_at)
       VALUES($1,$2,$3::jsonb,$4)
       ON CONFLICT (job_id) DO NOTHING`,
      [record.jobId, record.specHash, JSON.stringify(record), record.createdAt]
    );
    if (result.rowCount === 1) return;
    const existing = await this.get(record.jobId);
    if (existing?.specHash === record.specHash) return;
    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Job execution spec already exists with different authoritative content"
    );
  }
}
