import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { ControlApiPrincipal } from "@/lib/control-api/contracts";
import type { AuditEvent } from "@/lib/domain/audit";
import type { JobRecord } from "@/lib/domain/services/job-service";
import {
  assertAuthorizedBusinessActionRequest,
  type AuthorizedBusinessActionRequest
} from "@/lib/execution/adapters/business-action";
import type { BusinessActionExecutionRecord } from "@/lib/execution/business-action-orchestrator";
import {
  createPersistedJobExecutionSpec,
  type PersistedJobExecutionSpec
} from "@/lib/execution/job-execution-router";
import {
  createJobQueueEnvelope,
  type DeadLetterRecord,
  type JobRecoveryRecord,
  type JobRetryScheduleRecord,
  type JobStoreTransactionReceipt
} from "@/lib/execution/job-runtime-contracts";
import type {
  DurableJobExecutionOutcomeRecord,
  DurableJobRuntimeEventRecord
} from "@/lib/execution/job-runtime-records";
import type {
  DeadLetterDisposition,
  DeadLetterExecutionSpecView,
  DeadLetterOperatorAction,
  DeadLetterOperatorActionResult,
  DeadLetterOperatorActionView,
  DeadLetterOperatorView,
  DeadLetterSummary
} from "@/lib/control-api/dead-letter-contracts";
import {
  PostgresEntityStore,
  PostgresIdempotencyStore
} from "@/lib/persistence/postgres/authority-stores";
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";
import { PostgresJobExecutionSpecStore } from "@/lib/persistence/postgres/job-execution-spec-store";
import { PostgresDurableJobStore } from "@/lib/persistence/postgres/job-store";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";
import type { VerificationEvidence } from "@/lib/verification/verification";

interface RuntimeRow {
  envelope: {
    jobId: string;
    taskId: string;
    envelopeHash: string;
    scope: {
      portfolioId: string;
      companyId: string;
      environment: string;
    };
  };
  runtime_state: string;
  version: number;
  state_hash: string;
  attempt: number;
  scheduled_at: Date | string;
  updated_at: Date | string;
}

interface DeadLetterListRow extends RuntimeRow {
  dead_letter: DeadLetterRecord;
  operator_action: AuditEvent | null;
}

interface DeadLetterOperatorDependencies {
  jobs?: Pick<PostgresEntityStore<JobRecord>, "get">;
  specs?: Pick<PostgresJobExecutionSpecStore, "get" | "put">;
  queue?: Pick<PostgresDurableJobStore, "getRuntimeSnapshot" | "enqueue" | "cancel">;
  now?: () => Date;
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function requireElevated(principal: ControlApiPrincipal) {
  if (principal.role !== "owner" && principal.role !== "admin") {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Dead-letter operations require owner or admin role"
    );
  }
}

function disposition(actions: readonly DeadLetterOperatorActionView[], runtimeState: string): DeadLetterDisposition {
  if (runtimeState === "cancelled") return "cancelled";
  const latest = actions.at(-1)?.eventType;
  if (latest === "dead-letter.operator.redriven") return "redriven";
  if (latest === "dead-letter.operator.cancelled") return "cancelled";
  if (latest === "dead-letter.operator.dismissed") return "dismissed";
  return "open";
}

function actionView(event: AuditEvent): DeadLetterOperatorActionView {
  const metadata = event.metadata;
  return Object.freeze({
    eventType: event.eventType,
    actorId: event.actor.id,
    occurredAt: event.occurredAt,
    reason: typeof metadata.reason === "string" ? metadata.reason : undefined,
    replacementJobId: typeof metadata.replacementJobId === "string"
      ? metadata.replacementJobId
      : undefined,
    requestId: typeof metadata.requestId === "string" ? metadata.requestId : undefined
  });
}

function specView(record: PersistedJobExecutionSpec | null): DeadLetterExecutionSpecView | undefined {
  if (!record) return undefined;
  if (record.spec.kind !== "business-action") {
    return Object.freeze({
      specHash: record.specHash,
      kind: record.spec.kind,
      createdAt: record.createdAt
    });
  }
  return Object.freeze({
    specHash: record.specHash,
    kind: record.spec.kind,
    createdAt: record.createdAt,
    request: Object.freeze({
      id: record.spec.request.id,
      capability: record.spec.request.capability,
      inputHash: record.spec.request.inputHash,
      idempotencyKey: record.spec.request.idempotencyKey,
      timeoutMs: record.spec.request.timeoutMs
    })
  });
}

function positiveInteger(value: string | undefined, fallback: number, label: string) {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", label + " must be a positive integer");
  }
  return parsed;
}

export class DeadLetterOperatorService {
  private readonly jobs: Pick<PostgresEntityStore<JobRecord>, "get">;
  private readonly specs: Pick<PostgresJobExecutionSpecStore, "get" | "put">;
  private readonly queue: Pick<PostgresDurableJobStore, "getRuntimeSnapshot" | "enqueue" | "cancel">;
  private readonly now: () => Date;

  constructor(
    private readonly db: PostgresTransactionalDatabase,
    dependencies: DeadLetterOperatorDependencies = {}
  ) {
    this.jobs = dependencies.jobs ?? new PostgresEntityStore<JobRecord>(db, "job");
    this.specs = dependencies.specs ?? new PostgresJobExecutionSpecStore(db);
    this.queue = dependencies.queue ?? new PostgresDurableJobStore(db);
    this.now = dependencies.now ?? (() => new Date());
  }

  list(principal: ControlApiPrincipal): Promise<readonly DeadLetterSummary[]> {
    requireElevated(principal);
    return runWithPostgresTenantScope(principal.scope, async () => {
      const result = await this.db.query<DeadLetterListRow>(
        "SELECT r.envelope,r.runtime_state,r.version,r.state_hash,r.attempt,r.scheduled_at,r.updated_at," +
        " d.payload AS dead_letter," +
        " (SELECT a.payload FROM audit_events a WHERE a.entity_type='job' AND a.entity_id=r.job_id" +
        " AND a.payload->>'eventType' LIKE 'dead-letter.operator.%' ORDER BY a.sequence DESC LIMIT 1) AS operator_action" +
        " FROM job_dead_letters d JOIN job_runtime_state r ON r.job_id=d.job_id" +
        " WHERE r.envelope->'scope'->>'portfolioId'=$1 AND r.envelope->'scope'->>'companyId'=$2" +
        " ORDER BY d.failed_at DESC,r.job_id",
        [principal.scope.portfolioId, principal.scope.companyId]
      );
      return Object.freeze(result.rows.map((row) => {
        const actions = row.operator_action ? [actionView(row.operator_action)] : [];
        return Object.freeze({
          jobId: row.dead_letter.jobId,
          taskId: row.envelope.taskId,
          failedAt: row.dead_letter.failedAt,
          reason: row.dead_letter.reason,
          finalAttempt: row.dead_letter.finalAttempt,
          runtimeState: row.runtime_state,
          disposition: disposition(actions, row.runtime_state),
          updatedAt: iso(row.updated_at)
        });
      }));
    });
  }

  get(principal: ControlApiPrincipal, jobId: string): Promise<DeadLetterOperatorView | null> {
    requireElevated(principal);
    return runWithPostgresTenantScope(principal.scope, () =>
      this.getScoped(principal, jobId)
    );
  }

  private async getScoped(
    principal: ControlApiPrincipal,
    jobId: string
  ): Promise<DeadLetterOperatorView | null> {
    const runtimeResult = await this.db.query<RuntimeRow>(
      "SELECT envelope,runtime_state,version,state_hash,attempt,scheduled_at,updated_at" +
      " FROM job_runtime_state WHERE job_id=$1" +
      " AND envelope->'scope'->>'portfolioId'=$2 AND envelope->'scope'->>'companyId'=$3",
      [jobId, principal.scope.portfolioId, principal.scope.companyId]
    );
    const runtime = runtimeResult.rows[0];
    if (!runtime) return null;

    const [
      authoritativeJob,
      deadResult,
      retryResult,
      transactionResult,
      recoveryResult,
      outcomeResult,
      eventResult,
      persistedSpec,
      providerResult,
      verificationResult,
      auditResult
    ] = await Promise.all([
      this.jobs.get(jobId),
      this.db.query<{ payload: DeadLetterRecord }>(
        "SELECT payload FROM job_dead_letters WHERE job_id=$1",
        [jobId]
      ),
      this.db.query<{ payload: JobRetryScheduleRecord }>(
        "SELECT payload FROM job_retry_schedule WHERE job_id=$1 ORDER BY run_at,id",
        [jobId]
      ),
      this.db.query<{ payload: JobStoreTransactionReceipt }>(
        "SELECT payload FROM job_runtime_transactions WHERE job_id=$1 ORDER BY occurred_at,id",
        [jobId]
      ),
      this.db.query<{ payload: JobRecoveryRecord }>(
        "SELECT payload FROM job_recovery_records WHERE job_id=$1 ORDER BY recovered_at,id",
        [jobId]
      ),
      this.db.query<{ payload: DurableJobExecutionOutcomeRecord }>(
        "SELECT payload FROM job_execution_outcomes WHERE job_id=$1 ORDER BY occurred_at,id",
        [jobId]
      ),
      this.db.query<{ payload: DurableJobRuntimeEventRecord }>(
        "SELECT payload FROM job_runtime_events WHERE job_id=$1 ORDER BY occurred_at,id",
        [jobId]
      ),
      this.specs.get(jobId),
      this.db.query<{ payload: BusinessActionExecutionRecord }>(
        "SELECT payload FROM business_action_executions WHERE job_id=$1 ORDER BY updated_at,request_id",
        [jobId]
      ),
      this.db.query<{ payload: VerificationEvidence }>(
        "SELECT payload FROM business_action_verification_evidence WHERE job_id=$1 ORDER BY observed_at,evidence_id",
        [jobId]
      ),
      this.db.query<{ payload: AuditEvent }>(
        "SELECT payload FROM audit_events WHERE entity_type='job' AND entity_id=$1" +
        " AND payload->>'eventType' LIKE 'dead-letter.operator.%' ORDER BY sequence",
        [jobId]
      )
    ]);

    const deadLetter = deadResult.rows[0]?.payload;
    if (!deadLetter || !authoritativeJob) return null;
    const actions = auditResult.rows.map((row) => actionView(row.payload));
    const retries = retryResult.rows.map((row) => row.payload);
    const transactions = transactionResult.rows.map((row) => row.payload);
    const recoveries = recoveryResult.rows.map((row) => row.payload);
    const outcomes = outcomeResult.rows.map((row) => row.payload);
    const runtimeEvents = eventResult.rows.map((row) => row.payload);
    const providerEvidence = providerResult.rows.map((row) => row.payload);
    const verificationEvidence = verificationResult.rows.map((row) => row.payload);

    const lineageHash = sha256Hex({
      deadLetter: deadLetter.recordHash,
      retries: retries.map((item) => item.recordHash),
      transactions: transactions.map((item) => item.transactionHash),
      recoveries: recoveries.map((item) => item.recordHash),
      outcomes: outcomes.map((item) => item.recordHash),
      runtimeEvents: runtimeEvents.map((item) => item.recordHash),
      providerEvidence: providerEvidence.map((item) => item.recordHash),
      verificationEvidence: verificationEvidence.map((item) => item.evidenceHash)
    });

    return Object.freeze({
      jobId,
      taskId: runtime.envelope.taskId,
      disposition: disposition(actions, runtime.runtime_state),
      lineageHash,
      runtime: Object.freeze({
        state: runtime.runtime_state,
        version: runtime.version,
        stateHash: runtime.state_hash,
        attempt: runtime.attempt,
        scheduledAt: iso(runtime.scheduled_at),
        updatedAt: iso(runtime.updated_at),
        envelopeHash: runtime.envelope.envelopeHash
      }),
      authoritativeJob: Object.freeze({
        state: authoritativeJob.state,
        version: authoritativeJob.version,
        attempt: authoritativeJob.attempt,
        maxAttempts: authoritativeJob.maxAttempts,
        authorizationGrantId: authoritativeJob.authorizationGrantId,
        authorizationGrantHash: authoritativeJob.authorizationGrantHash,
        authorizationConsumptionHash: authoritativeJob.authorizationConsumption?.consumptionHash,
        failureReason: authoritativeJob.failureReason
      }),
      deadLetter,
      retries: Object.freeze(retries),
      transactions: Object.freeze(transactions),
      recoveries: Object.freeze(recoveries),
      outcomes: Object.freeze(outcomes),
      runtimeEvents: Object.freeze(runtimeEvents),
      executionSpec: specView(persistedSpec),
      providerEvidence: Object.freeze(providerEvidence),
      verificationEvidence: Object.freeze(verificationEvidence),
      operatorActions: Object.freeze(actions),
      retrySafety: Object.freeze({
        automaticRedriveSupported: persistedSpec?.spec.kind === "business-action",
        requiresDifferentJob: true as const,
        requiresFreshAuthorizationLineage: true as const,
        reusesOldProviderOperation: false as const
      })
    });
  }

  act(
    principal: ControlApiPrincipal,
    jobId: string,
    input: DeadLetterOperatorAction
  ): Promise<DeadLetterOperatorActionResult> {
    requireElevated(principal);
    return runWithPostgresTenantScope(principal.scope, () =>
      this.actScoped(principal, jobId, input)
    );
  }

  private async actScoped(
    principal: ControlApiPrincipal,
    jobId: string,
    input: DeadLetterOperatorAction
  ): Promise<DeadLetterOperatorActionResult> {
    const view = await this.getScoped(principal, jobId);
    if (!view) throw new ControlPlaneError("NOT_FOUND", "Dead-lettered Job was not found");
    if (view.runtime.state !== "dead-lettered" && !(input.action === "cancel" && view.runtime.state === "cancelled")) {
      throw new ControlPlaneError("CONFLICT", "Job is not in dead-letter operator state");
    }

    if (input.action === "retry") {
      await this.assertRedriveEligible(principal, view, input);
    }

    const guardKey = input.action === "retry"
      ? "dead-letter-redrive:" + sha256Hex({
          portfolioId: principal.scope.portfolioId,
          companyId: principal.scope.companyId,
          sourceJobId: jobId
        })
      : "dead-letter-operator:" + sha256Hex({
          portfolioId: principal.scope.portfolioId,
          companyId: principal.scope.companyId,
          sourceJobId: jobId,
          action: input.action,
          idempotencyKey: input.idempotencyKey
        });
    const fingerprint = sha256Hex({
      action: input.action,
      sourceJobId: jobId,
      replacementJobId: input.action === "retry" ? input.replacementJobId : null,
      credentialLeaseId: input.action === "retry" ? input.credentialLeaseId ?? null : null,
      reason: input.reason,
      portfolioId: principal.scope.portfolioId,
      companyId: principal.scope.companyId
    });

    const claim = await this.db.transaction(async (client) =>
      new PostgresIdempotencyStore(client).claim<DeadLetterOperatorActionResult>(
        guardKey,
        fingerprint,
        this.now().toISOString()
      )
    );
    if (claim.state === "CONFLICT") {
      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        input.action === "retry"
          ? "This dead-lettered Job already has a different redrive lineage"
          : "Dead-letter operator idempotency key was reused with different content"
      );
    }
    if (claim.state === "COMPLETED" && claim.record.result) {
      return claim.record.result;
    }

    try {
      const result = input.action === "retry"
        ? await this.redrive(principal, view, input, claim.record.createdAt, fingerprint)
        : input.action === "cancel"
          ? await this.cancel(view, input.reason)
          : this.result("dismiss", jobId, claim.record.createdAt);

      await this.appendAudit(principal, view.jobId, input, result, fingerprint);
      await this.db.transaction(async (client) =>
        new PostgresIdempotencyStore(client).complete(
          guardKey,
          fingerprint,
          result,
          this.now().toISOString()
        )
      );
      return result;
    } catch (error) {
      const code = error instanceof ControlPlaneError ? error.code : "INTERNAL";
      await this.db.transaction(async (client) =>
        new PostgresIdempotencyStore(client).fail(
          guardKey,
          fingerprint,
          code,
          this.now().toISOString()
        )
      ).catch(() => undefined);
      throw error;
    }
  }

  private result(
    action: DeadLetterOperatorActionResult["action"],
    sourceJobId: string,
    occurredAt: string,
    extra: Pick<DeadLetterOperatorActionResult, "replacementJobId" | "requestId"> = {}
  ): DeadLetterOperatorActionResult {
    return Object.freeze({
      action,
      sourceJobId,
      status: "completed" as const,
      occurredAt,
      ...extra
    });
  }

  private async cancel(view: DeadLetterOperatorView, reason: string) {
    const snapshot = await this.queue.getRuntimeSnapshot(view.jobId);
    if (!snapshot) throw new ControlPlaneError("NOT_FOUND", "Durable Job runtime state was not found");
    if (snapshot.state !== "cancelled") {
      await this.queue.cancel({
        jobId: view.jobId,
        reason,
        cancelledAt: this.now().toISOString(),
        expectedJobVersion: snapshot.version,
        expectedJobHash: snapshot.stateHash,
        idempotencyKey: "operator-cancel:" + view.jobId
      });
    }
    return this.result("cancel", view.jobId, this.now().toISOString());
  }

  private async assertRedriveEligible(
    principal: ControlApiPrincipal,
    sourceView: DeadLetterOperatorView,
    input: Extract<DeadLetterOperatorAction, { action: "retry" }>
  ) {
    if (input.replacementJobId === sourceView.jobId) {
      throw new ControlPlaneError("FORBIDDEN", "Dead-letter redrive requires a different replacement Job");
    }
    const [sourceJob, replacementJob, sourceSpec] = await Promise.all([
      this.jobs.get(sourceView.jobId),
      this.jobs.get(input.replacementJobId),
      this.specs.get(sourceView.jobId)
    ]);
    if (!sourceJob || !replacementJob || !sourceSpec) {
      throw new ControlPlaneError("NOT_FOUND", "Source or replacement authoritative lineage was not found");
    }
    if (sourceSpec.spec.kind !== "business-action") {
      throw new ControlPlaneError(
        "POLICY_BLOCKED",
        "Automatic dead-letter redrive is limited to governed business actions; create a newly authorized plan for this Job kind"
      );
    }
    if (
      replacementJob.portfolioId !== principal.scope.portfolioId
      || replacementJob.companyId !== principal.scope.companyId
      || replacementJob.state !== "queued"
      || !replacementJob.authorizationGrantId
      || !replacementJob.authorizationGrantHash
      || !replacementJob.authorizationConsumption
      || replacementJob.authorizationConsumption.consumerType !== "task"
      || replacementJob.authorizationConsumption.consumerId !== replacementJob.taskId
      || replacementJob.authorizationConsumption.grantId !== replacementJob.authorizationGrantId
      || replacementJob.authorizationConsumption.grantHash !== replacementJob.authorizationGrantHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Replacement Job must be a queued authoritative Job with intact Task authorization lineage in the same tenant"
      );
    }
    const replacementScope = replacementJob.authorizationConsumption.scope;
    if (
      replacementScope.portfolioId !== principal.scope.portfolioId
      || replacementScope.companyId !== principal.scope.companyId
      || replacementScope.environment !== principal.scope.environment
    ) {
      throw new ControlPlaneError("FORBIDDEN", "Replacement authorization scope does not match the operator scope");
    }
    if (
      sourceJob.authorizationGrantHash === replacementJob.authorizationGrantHash
      && sourceJob.authorizationConsumption?.consumptionHash
        === replacementJob.authorizationConsumption.consumptionHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Dead-letter redrive requires fresh authorization lineage, not the source Job grant/consumption"
      );
    }
  }

  private async redrive(
    principal: ControlApiPrincipal,
    sourceView: DeadLetterOperatorView,
    input: Extract<DeadLetterOperatorAction, { action: "retry" }>,
    createdAt: string,
    fingerprint: string
  ) {
    if (input.replacementJobId === sourceView.jobId) {
      throw new ControlPlaneError("FORBIDDEN", "Dead-letter redrive requires a different replacement Job");
    }
    const [sourceJob, replacementJob, sourceSpec] = await Promise.all([
      this.jobs.get(sourceView.jobId),
      this.jobs.get(input.replacementJobId),
      this.specs.get(sourceView.jobId)
    ]);
    if (!sourceJob || !replacementJob || !sourceSpec) {
      throw new ControlPlaneError("NOT_FOUND", "Source or replacement authoritative lineage was not found");
    }
    if (sourceSpec.spec.kind !== "business-action") {
      throw new ControlPlaneError(
        "POLICY_BLOCKED",
        "Automatic dead-letter redrive is limited to governed business actions; create a newly authorized plan for this Job kind"
      );
    }
    if (
      replacementJob.portfolioId !== principal.scope.portfolioId
      || replacementJob.companyId !== principal.scope.companyId
      || replacementJob.state !== "queued"
      || !replacementJob.authorizationGrantId
      || !replacementJob.authorizationGrantHash
      || !replacementJob.authorizationConsumption
      || replacementJob.authorizationConsumption.consumerType !== "task"
      || replacementJob.authorizationConsumption.consumerId !== replacementJob.taskId
      || replacementJob.authorizationConsumption.grantId !== replacementJob.authorizationGrantId
      || replacementJob.authorizationConsumption.grantHash !== replacementJob.authorizationGrantHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Replacement Job must be a queued authoritative Job with intact Task authorization lineage in the same tenant"
      );
    }
    const replacementScope = replacementJob.authorizationConsumption.scope;
    if (
      replacementScope.portfolioId !== principal.scope.portfolioId
      || replacementScope.companyId !== principal.scope.companyId
      || replacementScope.environment !== principal.scope.environment
    ) {
      throw new ControlPlaneError("FORBIDDEN", "Replacement authorization scope does not match the operator scope");
    }
    if (
      sourceJob.authorizationGrantHash === replacementJob.authorizationGrantHash
      && sourceJob.authorizationConsumption?.consumptionHash
        === replacementJob.authorizationConsumption.consumptionHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Dead-letter redrive requires fresh authorization lineage, not the source Job grant/consumption"
      );
    }

    const sourceRequest = sourceSpec.spec.request;
    const requestId = "dead-letter-redrive:" + sha256Hex({
      sourceJobId: sourceView.jobId,
      replacementJobId: replacementJob.id,
      fingerprint
    }).slice(0, 48);
    const request: AuthorizedBusinessActionRequest = Object.freeze({
      id: requestId,
      jobId: replacementJob.id,
      scope: replacementScope,
      capability: sourceRequest.capability,
      input: sourceRequest.input,
      inputHash: sourceRequest.inputHash,
      authorizationConsumptionHash: replacementJob.authorizationConsumption.consumptionHash,
      credentialLeaseId: input.credentialLeaseId,
      idempotencyKey: "dead-letter-redrive:" + sha256Hex({ requestId, fingerprint }),
      timeoutMs: sourceRequest.timeoutMs,
      attempt: 1
    });
    assertAuthorizedBusinessActionRequest(request);

    await this.specs.put(createPersistedJobExecutionSpec({
      kind: "business-action",
      jobId: replacementJob.id,
      authoritativeJobVersion: replacementJob.version,
      authoritativeJobHash: sha256Hex(replacementJob),
      request
    }, createdAt));

    await this.queue.enqueue(createJobQueueEnvelope({
      id: "queue:" + replacementJob.id,
      jobId: replacementJob.id,
      taskId: replacementJob.taskId,
      scope: replacementScope,
      authorizationConsumptionHash: replacementJob.authorizationConsumption.consumptionHash,
      idempotencyKey: "queue:" + request.idempotencyKey,
      scheduledAt: createdAt,
      createdAt
    }));

    return this.result("retry", sourceView.jobId, createdAt, {
      replacementJobId: replacementJob.id,
      requestId
    });
  }

  private async appendAudit(
    principal: ControlApiPrincipal,
    sourceJobId: string,
    input: DeadLetterOperatorAction,
    result: DeadLetterOperatorActionResult,
    fingerprint: string
  ) {
    const suffix = input.action === "retry"
      ? "redriven"
      : input.action === "cancel"
        ? "cancelled"
        : "dismissed";
    const id = "dead-letter-operator:" + sha256Hex({
      sourceJobId,
      action: input.action,
      fingerprint
    });
    const event: AuditEvent = Object.freeze({
      id,
      correlationId: id,
      eventType: "dead-letter.operator." + suffix,
      actor: principal.actor,
      scope: Object.freeze({
        userId: principal.scope.userId,
        portfolioId: principal.scope.portfolioId,
        companyId: principal.scope.companyId,
        resourceId: principal.scope.resourceId
      }),
      environment: principal.scope.environment,
      entityType: "job",
      entityId: sourceJobId,
      previousState: "dead-lettered",
      newState: input.action === "cancel" ? "cancelled" : "dead-lettered",
      provenance: "control-api:dead-letter-operator",
      occurredAt: result.occurredAt,
      metadata: Object.freeze({
        reason: input.reason,
        replacementJobId: result.replacementJobId ?? null,
        requestId: result.requestId ?? null,
        oldProviderReplay: false,
        freshAuthorizationRequired: input.action === "retry"
      })
    });
    await this.db.query(
      "INSERT INTO audit_events" +
      " (id,correlation_id,portfolio_id,company_id,entity_type,entity_id,occurred_at,payload)" +
      " VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (id) DO NOTHING",
      [
        event.id,
        event.correlationId,
        event.scope.portfolioId,
        event.scope.companyId,
        event.entityType,
        event.entityId,
        event.occurredAt,
        JSON.stringify(event)
      ]
    );
  }
}

let installed: DeadLetterOperatorService | null = null;

export function getDeadLetterOperatorServiceFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (installed) return installed;
  const db = getPostgresRuntimeFromEnv(env).database;
  const globalDepth = positiveInteger(
    env.GETDONE_JOB_QUEUE_DEPTH_LIMIT,
    1_000,
    "GETDONE_JOB_QUEUE_DEPTH_LIMIT"
  );
  const companyDepth = positiveInteger(
    env.GETDONE_JOB_COMPANY_QUEUE_DEPTH_LIMIT,
    250,
    "GETDONE_JOB_COMPANY_QUEUE_DEPTH_LIMIT"
  );
  installed = new DeadLetterOperatorService(db, {
    queue: new PostgresDurableJobStore(db, {
      maxQueueDepth: globalDepth,
      maxCompanyQueueDepth: companyDepth
    })
  });
  return installed;
}

export function resetDeadLetterOperatorServiceForTests() {
  installed = null;
}
