import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  claimIdempotency
} from "@/lib/domain/idempotency";
import type {
  OrchestrationGeneratedTaskStore
} from "@/lib/orchestration/task-job-materialization-flow";
import type {
  AuthorizationConsumptionRecord
} from "@/lib/authorization/grants";
import type { GeneratedTask } from "@/lib/planning/task-generator";
import {
  PostgresAuthorizationGrantStore,
  PostgresIdempotencyStore
} from "@/lib/persistence/postgres/authority-stores";
import type {
  PostgresTransactionalDatabase
} from "@/lib/persistence/postgres/client";
import {
  runWithPostgresTenantScope
} from "@/lib/persistence/postgres/tenant-context.server";

interface GeneratedTaskEnvelope {
  taskHash: string;
  task: GeneratedTask;
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

  private entityType() {
    return "orchestration-generated-task";
  }

  private claimKey(task: GeneratedTask) {
    return `orchestration-generated-task:${this.binding.runId}:${task.logicalKey}`;
  }

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

  private assertTaskIntegrity(
    task: GeneratedTask,
    expectedHash?: string
  ) {
    this.assertBinding(task);
    const taskHash = sha256Hex(task);
    if (expectedHash && taskHash !== expectedHash) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Persisted generated Task failed integrity verification"
      );
    }
    return taskHash;
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

    return runWithPostgresTenantScope(this.binding, () =>
      this.database.transaction(async (client) => {
      const taskHash = this.assertTaskIntegrity(task);
      const fingerprint = sha256Hex({
        runId: this.binding.runId,
        taskHash,
        authorizationConsumptionHash: consumption.consumptionHash
      });
      const idempotency = new PostgresIdempotencyStore(client);
      const claim = await claimIdempotency<GeneratedTask>(
        idempotency,
        this.claimKey(task),
        fingerprint,
        new Date(task.createdAt)
      );

      if (claim.state === "COMPLETED") {
        const existing = claim.record.result;
        if (
          !existing
          || this.assertTaskIntegrity(existing) !== taskHash
          || existing.authorizationConsumption.consumptionHash
            !== consumption.consumptionHash
        ) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Generated Task replay does not match durable authoritative content"
          );
        }
        return {
          created: false,
          task: existing,
          consumption: existing.authorizationConsumption
        };
      }

      if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
        throw new ControlPlaneError(
          "CONFLICT",
          "Generated Task claim is already in progress or previously failed"
        );
      }

      const envelope: GeneratedTaskEnvelope = {
        taskHash,
        task
      };
      try {
        await client.query(
          `INSERT INTO control_plane_entities
            (entity_type,id,portfolio_id,company_id,version,updated_at,payload)
           VALUES($1,$2,$3,$4,1,$5,$6::jsonb)`,
          [
            this.entityType(),
            task.id,
            this.binding.portfolioId,
            this.binding.companyId,
            task.createdAt,
            JSON.stringify(envelope)
          ]
        );
      } catch (error) {
        if (
          error
          && typeof error === "object"
          && "code" in error
          && (error as { code?: string }).code === "23505"
        ) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Generated Task ID already exists under different logical authority"
          );
        }
        throw error;
      }

      // The durable logical claim, generated Task artifact, and single-use
      // grant consumption commit together in this one SERIALIZABLE transaction.
      await new PostgresAuthorizationGrantStore(client).consume(consumption);
      await idempotency.complete(
        this.claimKey(task),
        fingerprint,
        task,
        task.createdAt
      );

      return {
        created: true,
        task,
        consumption
      };
      })
    );
  }

  async get(id: string): Promise<GeneratedTask | null> {
    return runWithPostgresTenantScope(this.binding, async () => {
      const result = await this.database.query<{
        payload: GeneratedTaskEnvelope;
      }>(
        `SELECT payload
         FROM control_plane_entities
         WHERE entity_type=$1
           AND id=$2
           AND portfolio_id=$3
           AND company_id=$4`,
        [
          this.entityType(),
          id,
          this.binding.portfolioId,
          this.binding.companyId
        ]
      );
      const envelope = result.rows[0]?.payload;
      if (!envelope) return null;
      this.assertTaskIntegrity(envelope.task, envelope.taskHash);
      return envelope.task;
    });
  }
}
