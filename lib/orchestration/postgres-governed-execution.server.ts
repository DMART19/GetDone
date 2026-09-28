import type { DurableJobStore } from "@/lib/execution/job-runtime-contracts";
import { JobService, type JobStores } from "@/lib/domain/services/job-service";
import { TaskService, type TaskStores } from "@/lib/domain/services/task-service";
import type { AuthoritativeDecision } from "@/lib/domain/decision-service";
import type { ApprovalRecord } from "@/lib/domain/services/approval-service";
import type {
  OrchestrationPolicyEvidenceProvider,
  OrchestrationValidationPolicyProvider
} from "@/lib/orchestration/governed-planning-stage-handler";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import type { OrchestrationStageHandler } from "@/lib/orchestration/coordinator";
import { DecisionApprovalMaterializer } from "@/lib/orchestration/decision-approval-materializer";
import {
  GovernedAuthorizationIssuer,
  type AuthorizationValidationEvidenceProvider
} from "@/lib/orchestration/governed-authorization-issuer";
import { GovernedExecutionStageHandler } from "@/lib/orchestration/governed-execution-stage-handler";
import { GovernedJobMaterializer } from "@/lib/orchestration/governed-job-materializer";
import { GovernedTaskMaterializer } from "@/lib/orchestration/governed-task-materializer";
import {
  PostgresAuthorizationGrantStore,
  PostgresEntityStore,
  PostgresVerificationReceiptStore
} from "@/lib/persistence/postgres/authority-stores";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";
import { PostgresControlPlaneTransactionManager } from "@/lib/persistence/postgres/transaction-manager";
import { PostgresOrchestrationPlanningArtifactStore } from "@/lib/persistence/postgres/orchestration-planning-artifact-store";
import { PostgresOrchestrationExecutionArtifactStore } from "@/lib/persistence/postgres/orchestration-execution-artifact-store";
import { PostgresTaskGenerationDedupeStore } from "@/lib/persistence/postgres/orchestration-task-dedupe-store";
import { PostgresDurableJobStore } from "@/lib/persistence/postgres/job-store";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";
import type { TaskRecord } from "@/lib/domain/services/task-service";
import type { JobRecord } from "@/lib/domain/services/job-service";

export interface PostgresGovernedExecutionDependencies {
  validationPolicies: OrchestrationValidationPolicyProvider;
  policyEvidence: OrchestrationPolicyEvidenceProvider;
  validationEvidence: AuthorizationValidationEvidenceProvider;
  durableJobs?: DurableJobStore;
}

function optionalPositiveInteger(value: string | undefined, name: string) {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function createPostgresGovernedExecutionStageHandler(
  deps: PostgresGovernedExecutionDependencies,
  env: Readonly<Record<string, string | undefined>> = process.env
): OrchestrationStageHandler {
  const db = getPostgresRuntimeFromEnv(env).database;
  const planning = new PostgresOrchestrationPlanningArtifactStore(db);
  const execution = new PostgresOrchestrationExecutionArtifactStore(db);
  const grantStore = new PostgresAuthorizationGrantStore(db);

  const decisionStore = new PostgresEntityStore<AuthoritativeDecision>(db, "decision");
  const approvalStore = new PostgresEntityStore<ApprovalRecord>(db, "approval");

  const decisionMaterializer = new DecisionApprovalMaterializer(
    new PostgresControlPlaneTransactionManager(db, (client) => ({
      decisions: new PostgresEntityStore<AuthoritativeDecision>(client, "decision"),
      approvals: new PostgresEntityStore<ApprovalRecord>(client, "approval")
    }))
  );

  const authorization = new GovernedAuthorizationIssuer(
    planning,
    execution,
    {
      getDecision: (id) => decisionStore.get(id),
      getApproval: (id) => approvalStore.get(id)
    },
    deps.validationPolicies,
    deps.policyEvidence,
    deps.validationEvidence,
    grantStore
  );

  const taskStore = new PostgresEntityStore<TaskRecord>(db, "task");
  const taskService = new TaskService(
    new PostgresControlPlaneTransactionManager<TaskStores>(db, (client) => ({
      tasks: new PostgresEntityStore<TaskRecord>(client, "task"),
      authorizationGrants: new PostgresAuthorizationGrantStore(client),
      verificationReceipts: new PostgresVerificationReceiptStore(client)
    }))
  );

  const taskMaterializer = new GovernedTaskMaterializer(
    planning,
    execution,
    new PostgresTaskGenerationDedupeStore(db),
    taskService,
    taskStore
  );

  const jobStore = new PostgresEntityStore<JobRecord>(db, "job");
  const jobService = new JobService(
    new PostgresControlPlaneTransactionManager<JobStores>(db, (client) => ({
      jobs: new PostgresEntityStore<JobRecord>(client, "job"),
      authorizationGrants: new PostgresAuthorizationGrantStore(client),
      verificationReceipts: new PostgresVerificationReceiptStore(client)
    }))
  );

  const durableJobs = deps.durableJobs ?? new PostgresDurableJobStore(db, {
    maxQueueDepth: optionalPositiveInteger(
      env.GETDONE_JOB_MAX_QUEUE_DEPTH,
      "GETDONE_JOB_MAX_QUEUE_DEPTH"
    ),
    maxCompanyQueueDepth: optionalPositiveInteger(
      env.GETDONE_JOB_MAX_COMPANY_QUEUE_DEPTH,
      "GETDONE_JOB_MAX_COMPANY_QUEUE_DEPTH"
    )
  });

  const jobMaterializer = new GovernedJobMaterializer(
    execution,
    taskService,
    taskStore,
    jobService,
    jobStore,
    durableJobs
  );

  const handler = new GovernedExecutionStageHandler(
    planning,
    decisionMaterializer,
    authorization,
    taskMaterializer,
    jobMaterializer
  );

  return Object.freeze({
    advance(run: OrchestrationRun) {
      return runWithPostgresTenantScope(
        { portfolioId: run.portfolioId, companyId: run.companyId },
        () => handler.advance(run)
      );
    }
  });
}
