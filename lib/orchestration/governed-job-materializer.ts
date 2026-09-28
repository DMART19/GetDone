import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { AuthorizationGrant } from "@/lib/authorization/grants";
import type { JobRecord, JobService } from "@/lib/domain/services/job-service";
import type { TaskRecord, TaskService } from "@/lib/domain/services/task-service";
import {
  createJobQueueEnvelope,
  type DurableJobStore
} from "@/lib/execution/job-runtime-contracts";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import type { OrchestrationExecutionArtifactStore } from "@/lib/orchestration/execution-artifact-store";
import {
  createJobBatchExecutionArtifact,
  executionArtifactId,
  type JobBatchExecutionArtifact
} from "@/lib/orchestration/execution-artifacts";

export interface GovernedJobReadStore {
  get(id: string): Promise<JobRecord | null>;
}

export interface GovernedJobTaskReadStore {
  get(id: string): Promise<TaskRecord | null>;
}

function executionScope(task: {
  scope: {
    userId: string;
    portfolioId: string;
    companyId: string;
    environment: "development" | "staging" | "production";
    resourceId?: string;
  };
}): TrustedExecutionScope {
  return Object.freeze({
    userId: task.scope.userId,
    portfolioId: task.scope.portfolioId,
    companyId: task.scope.companyId,
    environment: task.scope.environment,
    resourceId: task.scope.resourceId
  });
}

function command(input: {
  run: OrchestrationRun;
  scope: TrustedExecutionScope;
  entityType: "task" | "job";
  entityId: string;
  action: string;
}) {
  return createCommandEnvelope({
    commandId: `command:${sha256Hex({
      runId: input.run.id,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action
    })}`,
    actor: { type: "system", id: "orchestration" },
    scope: input.scope,
    correlationId: input.run.correlationId,
    environment: input.scope.environment,
    idempotencyKey:
      `orchestration:${input.run.id}:${input.entityType}:${input.entityId}:${input.action}`,
    provenance: "orchestration:job-materializer",
    requestedMutation: {
      type: `${input.entityType}.${input.action}`,
      [`${input.entityType}Id`]: input.entityId
    }
  });
}

function jobId(runId: string, taskId: string) {
  return `job:orchestration:${sha256Hex({ runId, taskId })}`;
}

export class GovernedJobMaterializer {
  constructor(
    private readonly execution: OrchestrationExecutionArtifactStore,
    private readonly taskService: TaskService,
    private readonly taskReads: GovernedJobTaskReadStore,
    private readonly jobService: JobService,
    private readonly jobReads: GovernedJobReadStore,
    private readonly durableJobs: DurableJobStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  async materializeAndEnqueue(run: OrchestrationRun): Promise<JobBatchExecutionArtifact> {
    const [taskDag, authorization] = await Promise.all([
      this.execution.latestTaskDag(run),
      this.execution.latestAuthorizationBundle(run)
    ]);
    if (!taskDag || !authorization) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Job materialization requires persisted Task DAG and Authorization bundle"
      );
    }
    if (
      taskDag.planHash !== authorization.planHash
      || taskDag.authorizationBundleId !== authorization.id
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Task DAG and Authorization bundle do not share exact plan lineage"
      );
    }

    const grantById = new Map(
      authorization.grants.map((grant) => [grant.id, grant] as const)
    );
    const taskById = new Map(taskDag.tasks.map((task) => [task.id, task] as const));
    const jobIdByTask = new Map(
      taskDag.tasks.map((task) => [task.id, jobId(run.id, task.id)] as const)
    );
    const jobs: JobRecord[] = [];

    // Materialize the complete Job graph first. This does not make any Job executable.
    for (const task of taskDag.tasks) {
      const id = jobIdByTask.get(task.id)!;
      const dependencyJobIds = task.dependsOnLogicalKeys.map((logicalKey) => {
        const dependencyTask = taskDag.tasks.find(
          (candidate) => candidate.logicalKey === logicalKey
        );
        if (!dependencyTask) {
          throw new ControlPlaneError(
            "CONFLICT",
            `Task DAG dependency is missing during Job materialization: ${logicalKey}`
          );
        }
        return jobIdByTask.get(dependencyTask.id)!;
      });

      let record = await this.jobReads.get(id);
      if (!record) {
        record = await this.jobService.create({
          id,
          taskId: task.id,
          dependencyJobIds,
          createdAt: task.createdAt
        }, command({
          run,
          scope: executionScope(task),
          entityType: "job",
          entityId: id,
          action: "create"
        }));
      }

      if (
        record.taskId !== task.id
        || JSON.stringify([...(record.dependencyJobIds ?? [])].sort())
          !== JSON.stringify([...dependencyJobIds].sort())
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Authoritative Job graph differs from the governed Task DAG"
        );
      }
      jobs.push(record);
    }

    const enqueued = [];

    // Existing domain invariants require dependencies to have authoritatively succeeded
    // before Task/Job queue transitions. Therefore only dependency-free roots enter the
    // durable queue in this tranche. Downstream Jobs remain materialized in "created".
    for (const task of taskDag.tasks.filter(
      (candidate) => candidate.dependsOnLogicalKeys.length === 0
    )) {
      const id = jobIdByTask.get(task.id)!;
      const grant = grantById.get(task.authorizationGrantId);
      if (!grant) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Root Task is missing its exact persisted AuthorizationGrant"
        );
      }
      if (
        grant.grantHash !== task.authorizationGrantHash
        || grant.stepId !== task.planStepId
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Root Task AuthorizationGrant does not match governed plan step"
        );
      }

      let taskRecord = await this.taskReads.get(task.id);
      if (!taskRecord) {
        throw new ControlPlaneError(
          "NOT_FOUND",
          "Authoritative Task disappeared before Job enqueue"
        );
      }
      if (taskRecord.state === "authorized") {
        taskRecord = await this.taskService.queue(
          task.id,
          command({
            run,
            scope: executionScope(task),
            entityType: "task",
            entityId: task.id,
            action: "queue"
          })
        );
      }
      if (
        !["queued", "running", "verifying", "succeeded"].includes(taskRecord.state)
        || !taskRecord.authorizationConsumption
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Root Task is not authoritatively queued with authorization consumption"
        );
      }

      let jobRecord = await this.jobReads.get(id);
      if (!jobRecord) {
        throw new ControlPlaneError(
          "NOT_FOUND",
          "Authoritative Job disappeared before durable enqueue"
        );
      }
      if (jobRecord.state === "created") {
        jobRecord = await this.jobService.queue(
          id,
          command({
            run,
            scope: executionScope(task),
            entityType: "job",
            entityId: id,
            action: "queue"
          }),
          grant,
          taskRecord.authorizationConsumption,
          this.now().toISOString()
        );
      }
      if (
        !["queued", "claimed", "running", "verifying", "succeeded"].includes(jobRecord.state)
        || !jobRecord.authorizationConsumption
        || jobRecord.authorizationConsumption.consumptionHash
          !== taskRecord.authorizationConsumption.consumptionHash
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Root Job does not inherit authoritative Task authorization lineage"
        );
      }

      // Stable envelope timestamps make crash/retry enqueue exactly idempotent.
      const envelope = createJobQueueEnvelope({
        id: `job-envelope:${id}`,
        correlationId: run.correlationId,
        jobId: id,
        taskId: task.id,
        scope: executionScope(task),
        authorizationConsumptionHash:
          taskRecord.authorizationConsumption.consumptionHash,
        idempotencyKey: `orchestration:${run.id}:durable-enqueue:${id}`,
        scheduledAt: task.createdAt,
        createdAt: task.createdAt
      });
      const durable = await this.durableJobs.enqueue(envelope);
      enqueued.push(Object.freeze({
        jobId: id,
        envelope,
        transaction: durable.transaction
      }));

      const index = jobs.findIndex((candidate) => candidate.id === id);
      if (index >= 0) jobs[index] = jobRecord;
    }

    // Assert every materialized Job still maps to the persisted task set.
    for (const job of jobs) {
      if (!taskById.has(job.taskId)) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Materialized Job references a Task outside the governed DAG"
        );
      }
    }

    const artifact = createJobBatchExecutionArtifact({
      id: executionArtifactId({
        kind: "job-batch",
        run,
        predecessorHash: taskDag.artifactHash
      }),
      runId: run.id,
      correlationId: run.correlationId,
      planHash: taskDag.planHash,
      taskDagArtifactId: taskDag.id,
      jobs,
      enqueued,
      providerExecutionSpecsCreated: false,
      createdAt: this.now().toISOString()
    });
    await this.execution.append(run, {
      kind: "job-batch",
      value: artifact
    });
    return artifact;
  }
}
