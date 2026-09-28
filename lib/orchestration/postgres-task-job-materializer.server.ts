import type { AuthorizationGrant } from "@/lib/authorization/grants";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  JobService,
  type JobRecord,
  type JobStores
} from "@/lib/domain/services/job-service";
import {
  TaskService,
  type TaskRecord,
  type TaskStores
} from "@/lib/domain/services/task-service";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import type { MvpJobRuntime } from "@/lib/execution/mvp-job-runtime.server";
import {
  orchestrationJobId,
  type OrchestrationJobAuthorityMaterializer,
  type OrchestrationObjectiveStatusStore,
  type OrchestrationTaskAuthorityMaterializer
} from "@/lib/orchestration/task-job-materialization-flow";
import type { OrchestrationRunRecord } from "@/lib/orchestration/contracts";
import type { GeneratedTask } from "@/lib/planning/task-generator";
import {
  PostgresAuthorizationGrantStore,
  PostgresEntityStore
} from "@/lib/persistence/postgres/authority-stores";
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";
import {
  PostgresControlPlaneTransactionManager
} from "@/lib/persistence/postgres/transaction-manager";
import {
  runWithPostgresTenantScope
} from "@/lib/persistence/postgres/tenant-context.server";

export interface OrchestrationCredentialLeaseResolver {
  resolve(input: {
    run: OrchestrationRunRecord;
    task: GeneratedTask;
    operationIndex: number;
  }): Promise<string | undefined>;
}

function orchestrationCommand(
  run: OrchestrationRunRecord,
  suffix: string,
  mutationType: string
) {
  const identity = sha256Hex({
    runId: run.id,
    suffix,
    mutationType
  });
  return createCommandEnvelope({
    commandId: `orchestration:${identity}`,
    actor: { type: "system", id: "getdone-orchestration" },
    scope: run.scope,
    correlationId: run.correlationId,
    environment: run.scope.environment,
    idempotencyKey: `orchestration:${identity}`,
    provenance: "core-product-orchestration",
    requestedMutation: { type: mutationType }
  });
}

export class PostgresOrchestrationObjectiveStatusStore
  implements OrchestrationObjectiveStatusStore {
  constructor(
    private readonly db: SqlQueryable,
    private readonly scope: { portfolioId: string; companyId: string }
  ) {}

  async getStatus(objectiveId: string) {
    return runWithPostgresTenantScope(this.scope, async () => {
      const result = await this.db.query<{
        payload: { status?: "active" | "paused" | "completed" };
      }>(
        `SELECT payload
         FROM control_plane_entities
         WHERE entity_type='objective'
           AND id=$1
           AND portfolio_id=$2
           AND company_id=$3`,
        [objectiveId, this.scope.portfolioId, this.scope.companyId]
      );
      return result.rows[0]?.payload.status ?? null;
    });
  }
}

export class PostgresOrchestrationTaskJobAuthority
  implements
    OrchestrationTaskAuthorityMaterializer,
    OrchestrationJobAuthorityMaterializer {
  constructor(
    private readonly database: PostgresTransactionalDatabase,
    private readonly jobRuntime: MvpJobRuntime,
    private readonly credentialLeases?: OrchestrationCredentialLeaseResolver,
    private readonly now: () => Date = () => new Date()
  ) {}

  private taskService() {
    return new TaskService(
      new PostgresControlPlaneTransactionManager<TaskStores>(
        this.database,
        (client) => ({
          tasks: new PostgresEntityStore<TaskRecord>(client, "task"),
          authorizationGrants: new PostgresAuthorizationGrantStore(client)
        })
      ),
      this.now
    );
  }

  private jobService() {
    return new JobService(
      new PostgresControlPlaneTransactionManager<JobStores>(
        this.database,
        (client) => ({
          jobs: new PostgresEntityStore<JobRecord>(client, "job"),
          authorizationGrants: new PostgresAuthorizationGrantStore(client)
        })
      ),
      this.now
    );
  }

  async materialize(input: {
    run: OrchestrationRunRecord;
    task: GeneratedTask;
    dependencyTaskIds: readonly string[];
    grant: AuthorizationGrant;
  }): Promise<TaskRecord>;
  async materialize(input: {
    run: OrchestrationRunRecord;
    task: GeneratedTask;
    grant: AuthorizationGrant;
    operationIndex: number;
    dependencyJobIds: readonly string[];
  }): Promise<JobRecord>;
  async materialize(input: {
    run: OrchestrationRunRecord;
    task: GeneratedTask;
    grant: AuthorizationGrant;
    operationIndex?: number;
    dependencyTaskIds?: readonly string[];
    dependencyJobIds?: readonly string[];
  }): Promise<TaskRecord | JobRecord> {
    return runWithPostgresTenantScope(input.run.scope, async () => {
    if (input.operationIndex === undefined) {
      const service = this.taskService();
      const retryable = input.task.resourceRequirements.execution.retryable;
      await service.create({
        id: input.task.id,
        reason: input.task.reason,
        evidenceIds: input.task.evidenceIds,
        capabilityRequirements: input.task.capabilityRequirements,
        dependencyTaskIds: input.dependencyTaskIds ?? [],
        maxRetries: retryable ? 3 : 0,
        createdAt: input.task.createdAt
      }, orchestrationCommand(
        input.run,
        `task:${input.task.id}:create`,
        "task.create"
      ));

      return service.authorize(
        input.task.id,
        orchestrationCommand(
          input.run,
          `task:${input.task.id}:authorize`,
          "task.authorize"
        ),
        input.grant,
        input.task.authorizationConsumption.consumedAt
      );
    }

    const operation = input.task.operations[input.operationIndex];
    if (!operation) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Job materialization operation index is outside the generated Task"
      );
    }
    if (
      !input.task.capabilityRequirements.includes(operation.capability)
      || !input.grant.capabilityNames.includes(operation.capability)
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Job operation capability is outside exact Task authorization"
      );
    }

    const service = this.jobService();
    return service.create({
      id: orchestrationJobId(
        input.run.id,
        input.task.planStepId,
        input.operationIndex
      ),
      taskId: input.task.id,
      dependencyJobIds: input.dependencyJobIds ?? [],
      maxAttempts: input.task.resourceRequirements.execution.retryable ? 5 : 1,
      createdAt: this.now().toISOString()
    }, orchestrationCommand(
      input.run,
      `job:${input.task.planStepId}:op:${input.operationIndex + 1}:create`,
      "job.create"
    ));
    });
  }

  async enqueue(input: {
    run: OrchestrationRunRecord;
    task: GeneratedTask;
    grant: AuthorizationGrant;
    operationIndex: number;
    job: JobRecord;
  }) {
    return runWithPostgresTenantScope(input.run.scope, async () => {
    const operation = input.task.operations[input.operationIndex];
    if (!operation) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Job enqueue operation index is outside the generated Task"
      );
    }

    const credentialLeaseId = await this.credentialLeases?.resolve({
      run: input.run,
      task: input.task,
      operationIndex: input.operationIndex
    });
    if (input.run.scope.environment === "production" && !credentialLeaseId) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "Production Job admission requires a governed credential lease; no synthetic credential authority is allowed"
      );
    }

    const queued = await this.jobService().queue(
      input.job.id,
      orchestrationCommand(
        input.run,
        `job:${input.job.id}:queue`,
        "job.queue"
      ),
      input.grant,
      input.task.authorizationConsumption,
      this.now().toISOString()
    );

    const expectedSeconds =
      input.task.resourceRequirements.execution.expectedDurationSeconds ?? 60;
    const request: AuthorizedBusinessActionRequest = Object.freeze({
      id: `business-action:${queued.id}`,
      correlationId: input.run.correlationId,
      jobId: queued.id,
      scope: input.task.authorizationConsumption.scope,
      capability: operation.capability,
      input: operation.input,
      inputHash: sha256Hex(operation.input),
      authorizationConsumptionHash:
        input.task.authorizationConsumption.consumptionHash,
      credentialLeaseId,
      idempotencyKey: `orchestration:${input.run.id}:job:${queued.id}:execute`,
      timeoutMs: Math.min(
        900_000,
        Math.max(1_000, expectedSeconds * 1_000)
      ),
      attempt: 1
    });

    // This is durable queue admission only. MvpJobRuntime re-reads the exact
    // authoritative queued Job and persists an execution spec before enqueue.
    // Provider execution remains the responsibility of the separate Job worker.
    await this.jobRuntime.enqueueAuthorizedBusinessAction(queued, request);
    return queued;
    });
  }
}
