import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  OrchestrationGeneratedTaskStore
} from "@/lib/orchestration/task-job-materialization-flow";
import type {
  AuthorizationConsumptionRecord
} from "@/lib/authorization/grants";
import type { GeneratedTask } from "@/lib/planning/task-generator";
import {
  PostgresAuthorizationGrantStore
} from "@/lib/persistence/postgres/authority-stores";
import type {
  PostgresTransactionalDatabase
} from "@/lib/persistence/postgres/client";

interface GeneratedTaskRow {
  payload: GeneratedTask;
  task_hash: string;
  authorization_consumption_hash: string;
}

export class PostgresOrchestrationGeneratedTaskStore
  implements OrchestrationGeneratedTaskStore {
  constructor(
    private readonly database: PostgresTransactionalDatabase,
    private readonly binding: {
      runId: string;
      portfolioId: string;
      companyId: string;
    }
  ) {}

  private assertBinding(task: GeneratedTask) {
    if (
      task.scope.portfolioId !== this.binding.portfolioId
      || task.scope.companyId !== this.binding.companyId
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Generated Task is outside the bound orchestration tenant"
      );
    }
  }

  async claim(
    task: GeneratedTask,
    consumption: AuthorizationConsumptionRecord
  ) {
    this.assertBinding(task);
    if (
      task.authorizationConsumption.consumptionHash !== consumption.consumptionHash
      || task.authorizationConsumption.grantId !== consumption.grantId
      || task.authorizationConsumption.consumerId !== task.id
      || consumption.consumerType !== "task"
      || consumption.consumerId !== task.id
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Generated Task claim does not match exact authorization consumption"
      );
    }

    return this.database.transaction(async (client) => {
      const taskHash = sha256Hex(task);
      const inserted = await client.query(
        `INSERT INTO orchestration_generated_tasks
          (
            id,run_id,portfolio_id,company_id,logical_key,plan_id,plan_step_id,
            task_hash,authorization_grant_id,authorization_consumption_hash,
            created_at,payload
          )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
         ON CONFLICT (run_id,logical_key) DO NOTHING`,
        [
          task.id,
          this.binding.runId,
          this.binding.portfolioId,
          this.binding.companyId,
          task.logicalKey,
          task.planId,
          task.planStepId,
          taskHash,
          task.authorizationGrantId,
          consumption.consumptionHash,
          task.createdAt,
          JSON.stringify(task)
        ]
      );

      if (inserted.rowCount === 1) {
        // The TaskGenerator contract requires the durable logical Task claim
        // and the single-use grant consumption to commit atomically.
        await new PostgresAuthorizationGrantStore(client).consume(consumption);
        return {
          created: true,
          task,
          consumption
        };
      }

      const replay = await client.query<GeneratedTaskRow>(
        `SELECT payload,task_hash,authorization_consumption_hash
         FROM orchestration_generated_tasks
         WHERE run_id=$1 AND logical_key=$2`,
        [this.binding.runId, task.logicalKey]
      );
      const existing = replay.rows[0];
      if (
        !existing
        || existing.task_hash !== taskHash
        || existing.authorization_consumption_hash !== consumption.consumptionHash
        || sha256Hex(existing.payload) !== existing.task_hash
        || existing.payload.id !== task.id
        || existing.payload.planStepId !== task.planStepId
        || existing.payload.authorizationConsumption.consumptionHash
          !== consumption.consumptionHash
      ) {
        throw new ControlPlaneError(
          "IDEMPOTENCY_CONFLICT",
          "Generated Task logical identity already exists with different authoritative content"
        );
      }

      return {
        created: false,
        task: existing.payload,
        consumption: existing.payload.authorizationConsumption
      };
    });
  }

  async get(id: string): Promise<GeneratedTask | null> {
    const result = await this.database.query<GeneratedTaskRow>(
      `SELECT payload,task_hash,authorization_consumption_hash
       FROM orchestration_generated_tasks
       WHERE id=$1 AND run_id=$2 AND portfolio_id=$3 AND company_id=$4`,
      [
        id,
        this.binding.runId,
        this.binding.portfolioId,
        this.binding.companyId
      ]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (
      sha256Hex(row.payload) !== row.task_hash
      || row.payload.authorizationConsumption.consumptionHash
        !== row.authorization_consumption_hash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Persisted generated Task failed integrity verification"
      );
    }
    this.assertBinding(row.payload);
    return row.payload;
  }
}
