import { timingSafeEqual } from "node:crypto";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { ControlApiPrincipal } from "@/lib/control-api/contracts";
import { getControlApiAdapter } from "@/lib/control-api/runtime.server";
import type { AuthoritativeDecision } from "@/lib/domain/decision-service";
import { TaskService, type TaskRecord, type TaskStores } from "@/lib/domain/services/task-service";
import { JobService, type JobRecord, type JobStores } from "@/lib/domain/services/job-service";
import type { AuthorizationGrant } from "@/lib/authorization/grants";
import { getMvpJobRuntimeFromEnv } from "@/lib/execution/mvp-job-runtime.server";
import { PostgresControlPlaneTransactionManager } from "@/lib/persistence/postgres/transaction-manager";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";
import {
  PostgresAuthorizationGrantStore,
  PostgresAuditLedger,
  PostgresEntityStore
} from "@/lib/persistence/postgres/authority-stores";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";
import { createAuditEvent } from "@/lib/domain/audit";

export const STAGING_BROWSER_ACCEPTANCE_VERSION = "1.0.0";

type DecisionPresentation = AuthoritativeDecision & {
  title: string;
  subtitle: string;
  priority: "normal" | "high";
  category: "growth";
  rationale: string;
  impact: readonly string[];
};

function envGuard(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (
    env.GETDONE_RUNTIME_ENV !== "staging"
    || env.GETDONE_STAGING_BROWSER_E2E !== "true"
  ) {
    throw new ControlPlaneError(
      "NOT_FOUND",
      "Staging browser acceptance surface is unavailable"
    );
  }
}

function safeTokenEqual(left: string | undefined, right: string | undefined) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function assertStagingBrowserAcceptanceRequest(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  envGuard(env);
  const supplied = request.headers.get("x-getdone-staging-acceptance-token")?.trim();
  const expected = env.GETDONE_STAGING_ACCEPTANCE_TOKEN?.trim();
  if (!safeTokenEqual(supplied, expected)) {
    throw new ControlPlaneError(
      "UNAUTHENTICATED",
      "Staging acceptance token is required"
    );
  }
}

async function principalFor(request: Request) {
  const principal = await getControlApiAdapter().authenticate(request);
  if (principal.role !== "owner") {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Owner role is required for staging browser acceptance"
    );
  }
  return principal;
}

function command(
  principal: ControlApiPrincipal,
  correlationId: string,
  suffix: string,
  mutation: Readonly<Record<string, unknown>>
) {
  return createCommandEnvelope({
    commandId: `staging-browser:${suffix}:${correlationId}`,
    actor: principal.actor,
    scope: principal.scope,
    correlationId,
    environment: principal.scope.environment,
    idempotencyKey: `staging-browser:${suffix}:${correlationId}`,
    provenance: "staging-browser-acceptance",
    requestedMutation: mutation
  });
}

function acceptanceGrant(
  principal: ControlApiPrincipal,
  decision: AuthoritativeDecision,
  correlationId: string,
  now = new Date()
): AuthorizationGrant {
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
  const planId = `staging-plan:${correlationId}`;
  const stepId = "safe-integration";
  const planHash = sha256Hex({ planId, correlationId, decisionId: decision.id });
  const stepHash = sha256Hex({ planHash, stepId, capability: "http.request" });
  const base: Omit<AuthorizationGrant, "grantHash"> = {
    id: `staging-grant:${correlationId}`,
    status: "active",
    disposition: "APPROVAL_REQUIRED",
    scope: { ...principal.scope },
    planId,
    planVersion: 1,
    planHash,
    stepId,
    stepHash,
    capabilityNames: ["http.request"],
    validationReceiptId: `staging-validation:${correlationId}`,
    validationReceiptHash: sha256Hex({ correlationId, kind: "staging-validation" }),
    policySnapshotId: `staging-policy:${correlationId}`,
    policySnapshotHash: sha256Hex({ correlationId, kind: "staging-policy" }),
    policyVersion: "staging-browser-acceptance",
    policyEngineVersion: "staging-browser-acceptance",
    policyRulesHash: sha256Hex("staging-browser-acceptance-rules"),
    decisionId: decision.id,
    approvalProofId: `staging-approval:${decision.id}`,
    approvalProofHash: sha256Hex({
      decisionId: decision.id,
      status: decision.status,
      correlationId
    }),
    actor: { ...principal.actor },
    issuedAt,
    expiresAt
  };
  return Object.freeze({ ...base, grantHash: sha256Hex(base) });
}

async function intentForCorrelation(
  db: ReturnType<typeof getPostgresRuntimeFromEnv>["database"],
  principal: ControlApiPrincipal,
  correlationId: string
) {
  const result = await db.query<{ payload: { id: string; correlationId?: string } }>(
    `SELECT payload FROM owner_intents
     WHERE portfolio_id=$1 AND company_id=$2
       AND payload->>'correlationId'=$3
     ORDER BY received_at DESC LIMIT 1`,
    [
      principal.scope.portfolioId,
      principal.scope.companyId,
      correlationId
    ]
  );
  return result.rows[0]?.payload ?? null;
}

export async function createAcceptanceDecision(
  request: Request,
  correlationId: string,
  requiresStepUp = false
) {
  assertStagingBrowserAcceptanceRequest(request);
  const principal = await principalFor(request);
  const runtime = getPostgresRuntimeFromEnv();
  const db = runtime.database;
  const intent = await intentForCorrelation(db, principal, correlationId);
  if (!intent) {
    throw new ControlPlaneError(
      "NOT_FOUND",
      "Authoritative owner intent was not found for correlation lineage"
    );
  }

  const id = `browser-decision:${correlationId}`;
  const decisions = new PostgresEntityStore<DecisionPresentation>(db, "decision");
  const existing = await decisions.get(id);
  if (existing) return existing;

  const now = new Date().toISOString();
  const decision: DecisionPresentation = Object.freeze({
    id,
    correlationId,
    portfolioId: principal.scope.portfolioId,
    companyId: principal.scope.companyId,
    status: "pending",
    version: 1,
    requiresStepUp,
    updatedAt: now,
    title: requiresStepUp
      ? "Approve secure browser acceptance"
      : "Approve browser acceptance execution",
    subtitle: requiresStepUp
      ? "Staging · passkey step-up required"
      : "Staging · safe governed integration",
    priority: requiresStepUp ? "high" : "normal",
    category: "growth",
    rationale: "Exercise the authoritative staging control plane with a harmless provider object.",
    impact: Object.freeze([
      "Creates one bounded staging Task and Job.",
      "Executes only the staging.browser.safe operation.",
      "Persists provider verification evidence and durable completion."
    ])
  });

  await decisions.create(decision);
  await new PostgresAuditLedger(db).append(createAuditEvent({
    correlationId,
    eventType: "decision.created",
    actor: principal.actor,
    scope: {
      userId: principal.scope.userId,
      portfolioId: principal.scope.portfolioId,
      companyId: principal.scope.companyId
    },
    environment: principal.scope.environment,
    entityType: "decision",
    entityId: decision.id,
    newState: "pending",
    provenance: "staging-browser-acceptance",
    metadata: {
      ownerIntentId: intent.id,
      requiresStepUp
    }
  }));
  return decision;
}

export interface StagingBrowserAcceptanceResult {
  correlationId: string;
  decisionId: string;
  taskId: string;
  jobId: string;
  controlPlaneJobState: string;
  runtimeState: string | null;
  providerState: string | null;
  providerOperationId: string | null;
  verificationEvidenceId: string | null;
  verificationResult: string | null;
  durableOutcome: string | null;
  authoritativeCompletion: boolean;
}

export async function readAcceptanceResult(
  scope: TrustedExecutionScope,
  jobId: string
): Promise<StagingBrowserAcceptanceResult> {
  envGuard();
  const db = getPostgresRuntimeFromEnv().database;
  const jobResult = await db.query<{ payload: JobRecord }>(
    `SELECT payload FROM control_plane_entities
     WHERE entity_type='job' AND id=$1
       AND portfolio_id=$2 AND company_id=$3`,
    [jobId, scope.portfolioId, scope.companyId]
  );
  const job = jobResult.rows[0]?.payload;
  if (!job) throw new ControlPlaneError("NOT_FOUND", "Acceptance Job was not found");

  const [runtime, provider, evidence, outcome] = await Promise.all([
    db.query<{ runtime_state: string; envelope: { correlationId?: string } }>(
      "SELECT runtime_state,envelope FROM job_runtime_state WHERE job_id=$1",
      [jobId]
    ),
    db.query<{
      state: string;
      provider_operation_id: string | null;
      payload: { correlationId?: string };
    }>(
      `SELECT state,provider_operation_id,payload
       FROM business_action_executions WHERE job_id=$1
       ORDER BY updated_at DESC LIMIT 1`,
      [jobId]
    ),
    db.query<{
      evidence_id: string;
      payload: { correlationId?: string; result?: string };
    }>(
      `SELECT evidence_id,payload FROM business_action_verification_evidence
       WHERE job_id=$1 ORDER BY observed_at DESC LIMIT 1`,
      [jobId]
    ),
    db.query<{ kind: string; payload: { correlationId?: string } }>(
      `SELECT kind,payload FROM job_execution_outcomes
       WHERE job_id=$1 ORDER BY occurred_at DESC LIMIT 1`,
      [jobId]
    )
  ]);

  const correlationId = job.correlationId ?? "";
  const runtimeRow = runtime.rows[0];
  const providerRow = provider.rows[0];
  const evidenceRow = evidence.rows[0];
  const outcomeRow = outcome.rows[0];
  const lineageMatches = Boolean(
    correlationId
    && runtimeRow?.envelope.correlationId === correlationId
    && providerRow?.payload.correlationId === correlationId
    && evidenceRow?.payload.correlationId === correlationId
    && outcomeRow?.payload.correlationId === correlationId
  );
  const authoritativeCompletion = Boolean(
    lineageMatches
    && runtimeRow?.runtime_state === "released"
    && providerRow?.state === "completed"
    && evidenceRow?.payload.result === "pass"
    && outcomeRow?.kind === "succeeded"
  );

  return Object.freeze({
    correlationId,
    decisionId: `browser-decision:${correlationId}`,
    taskId: job.taskId,
    jobId,
    controlPlaneJobState: job.state,
    runtimeState: runtimeRow?.runtime_state ?? null,
    providerState: providerRow?.state ?? null,
    providerOperationId: providerRow?.provider_operation_id ?? null,
    verificationEvidenceId: evidenceRow?.evidence_id ?? null,
    verificationResult: evidenceRow?.payload.result ?? null,
    durableOutcome: outcomeRow?.kind ?? null,
    authoritativeCompletion
  });
}

export async function executeAcceptanceDecision(
  request: Request,
  decisionId: string
) {
  assertStagingBrowserAcceptanceRequest(request);
  const principal = await principalFor(request);
  const db = getPostgresRuntimeFromEnv().database;
  const decisions = new PostgresEntityStore<AuthoritativeDecision>(db, "decision");
  const decision = await decisions.get(decisionId);
  if (
    !decision
    || decision.portfolioId !== principal.scope.portfolioId
    || decision.companyId !== principal.scope.companyId
    || decision.status !== "approved"
    || !decision.correlationId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "An approved authoritative Decision with correlation lineage is required"
    );
  }
  const correlationId = decision.correlationId;
  const taskId = `browser-task:${correlationId}`;
  const jobId = `browser-job:${correlationId}`;

  const existingJob = await new PostgresEntityStore<JobRecord>(db, "job").get(jobId);
  if (existingJob) {
    const prior = await readAcceptanceResult(principal.scope, jobId);
    if (prior.authoritativeCompletion) return prior;
  }

  return runWithPostgresTenantScope(principal.scope, async () => {
    const grant = acceptanceGrant(principal, decision, correlationId);
    const grantStore = new PostgresAuthorizationGrantStore(db);
    await grantStore.insert(grant);

    const taskManager = new PostgresControlPlaneTransactionManager<TaskStores>(
      db,
      (client) => ({
        tasks: new PostgresEntityStore<TaskRecord>(client, "task"),
        authorizationGrants: new PostgresAuthorizationGrantStore(client)
      })
    );
    const taskService = new TaskService(taskManager);
    const createdTask = await taskService.create({
      id: taskId,
      reason: "Production browser staging acceptance",
      capabilityRequirements: ["http.request"],
      maxRetries: 1
    }, command(principal, correlationId, "task-create", { type: "task.create" }));
    const authorizedTask = await taskService.authorize(
      createdTask.id,
      command(principal, correlationId, "task-authorize", { type: "task.authorize" }),
      grant
    );
    const queuedTask = await taskService.queue(
      authorizedTask.id,
      command(principal, correlationId, "task-queue", { type: "task.queue" })
    );
    if (!queuedTask.authorizationConsumption) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Staging acceptance Task is missing authorization consumption"
      );
    }

    const jobManager = new PostgresControlPlaneTransactionManager<JobStores>(
      db,
      (client) => ({
        jobs: new PostgresEntityStore<JobRecord>(client, "job"),
        authorizationGrants: new PostgresAuthorizationGrantStore(client)
      })
    );
    const jobService = new JobService(jobManager);
    const createdJob = await jobService.create({
      id: jobId,
      taskId,
      maxAttempts: 2
    }, command(principal, correlationId, "job-create", { type: "job.create" }));
    const queuedJob = await jobService.queue(
      createdJob.id,
      command(principal, correlationId, "job-queue", { type: "job.queue" }),
      grant,
      queuedTask.authorizationConsumption
    );

    const actionInput = {
      companyId: principal.scope.companyId,
      operation: "staging.browser.safe",
      payload: {
        correlationId,
        decisionId,
        purpose: "production-browser-e2e"
      }
    };
    const runtime = getMvpJobRuntimeFromEnv();
    await runtime.enqueueAuthorizedBusinessAction(queuedJob, {
      id: `browser-action:${correlationId}`,
      correlationId,
      jobId,
      scope: principal.scope,
      capability: "http.request",
      input: actionInput,
      inputHash: sha256Hex(actionInput),
      authorizationConsumptionHash: queuedTask.authorizationConsumption.consumptionHash,
      idempotencyKey: `browser-action:${correlationId}`,
      timeoutMs: 10_000,
      attempt: 1
    });
    const results = await runtime.runOnce();
    const outcome = results.find((item) => item.jobId === jobId)?.outcome;
    if (!outcome || outcome.kind !== "succeeded") {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        `Staging acceptance Job did not succeed: ${outcome?.kind ?? "missing"}`
      );
    }

    const result = await readAcceptanceResult(principal.scope, jobId);
    if (!result.authoritativeCompletion) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "Staging acceptance completion evidence is incomplete"
      );
    }
    return result;
  });
}
