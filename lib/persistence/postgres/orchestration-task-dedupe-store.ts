import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  assertAuthorizationConsumption,
  type AuthorizationConsumptionRecord
} from "@/lib/authorization/grants";
import type { GeneratedTask, TaskGenerationDedupeStore } from "@/lib/planning/task-generator";
import type { PostgresTransactionalDatabase, QueryResultRow } from "@/lib/persistence/postgres/client";
import { PostgresAuthorizationGrantStore } from "@/lib/persistence/postgres/authority-stores";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

interface ClaimRow extends QueryResultRow {
  task_id: string;
  logical_key: string;
  task_hash: string;
  grant_id: string;
  consumption_hash: string;
  task_payload: GeneratedTask;
  consumption_payload: AuthorizationConsumptionRecord;
}

function taskHash(task: GeneratedTask) {
  return task.authorizationConsumption.consumptionHash;
}

export class PostgresTaskGenerationDedupeStore implements TaskGenerationDedupeStore {
  constructor(private readonly db: PostgresTransactionalDatabase) {}

  async claim(
    task: GeneratedTask,
    consumption: AuthorizationConsumptionRecord
  ) {
    if (
      task.authorizationConsumption.consumptionHash !== consumption.consumptionHash
      || task.authorizationGrantId !== consumption.grantId
      || consumption.consumerId !== task.id
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Task generation candidate and authorization consumption do not match"
      );
    }

    return runWithPostgresTenantScope(
      {
        portfolioId: task.scope.portfolioId,
        companyId: task.scope.companyId
      },
      () => this.db.transaction(async (client) => {
        const existing = await client.query<ClaimRow>(
          `SELECT * FROM orchestration_task_generation_claims
           WHERE portfolio_id=$1 AND company_id=$2 AND logical_key=$3
           FOR UPDATE`,
          [task.scope.portfolioId, task.scope.companyId, task.logicalKey]
        );
        const prior = existing.rows[0];

        if (prior) {
          if (
            prior.task_id !== task.id
            || prior.grant_id !== task.authorizationGrantId
            || prior.consumption_hash !== consumption.consumptionHash
          ) {
            throw new ControlPlaneError(
              "IDEMPOTENCY_CONFLICT",
              "Logical Task claim already exists with different authorization lineage"
            );
          }
          return {
            created: false,
            task: prior.task_payload,
            consumption: prior.consumption_payload
          };
        }

        const grants = new PostgresAuthorizationGrantStore(client);
        const grant = await grants.get(consumption.grantId);
        if (!grant) {
          throw new ControlPlaneError(
            "NOT_FOUND",
            "Authorization grant must be persisted before Task generation"
          );
        }
        assertAuthorizationConsumption(consumption, grant);
        await grants.consume(consumption);

        await client.query(
          `INSERT INTO orchestration_task_generation_claims (
             portfolio_id,company_id,logical_key,task_id,task_hash,
             grant_id,consumption_hash,task_payload,consumption_payload,created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)`,
          [
            task.scope.portfolioId,
            task.scope.companyId,
            task.logicalKey,
            task.id,
            taskHash(task),
            task.authorizationGrantId,
            consumption.consumptionHash,
            JSON.stringify(task),
            JSON.stringify(consumption),
            task.createdAt
          ]
        );

        return {
          created: true,
          task,
          consumption
        };
      })
    );
  }
}
