import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { ControlApiPrincipal } from "@/lib/control-api/contracts";
import type { AuditEvent } from "@/lib/domain/audit";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import type { BusinessActionExecutionRecord } from "@/lib/execution/business-action-orchestrator";
import { DeadLetterOperatorService } from "@/lib/execution/dead-letter-operator.server";
import {
  createPersistedJobExecutionSpec,
  type PersistedJobExecutionSpec
} from "@/lib/execution/job-execution-router";
import {
  createDeadLetterRecord,
  createJobRecoveryRecord,
  createJobRetryScheduleRecord,
  createJobStoreTransactionReceipt,
  type JobQueueEnvelope
} from "@/lib/execution/job-runtime-contracts";
import {
  createDurableJobExecutionOutcome,
  createDurableJobRuntimeEvent
} from "@/lib/execution/job-runtime-records";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";
import { createVerificationEvidence } from "@/lib/verification/verification";

const at = "2026-09-23T20:00:00.000Z";
const scope = Object.freeze({
  userId: "owner-unit",
  portfolioId: "portfolio-unit",
  companyId: "company-unit",
  environment: "staging" as const
});
const principal: ControlApiPrincipal = Object.freeze({
  actor: { type: "user", id: scope.userId },
  scope,
  sessionId: "session-unit",
  role: "owner"
});

function authoritativeJob(
  id: string,
  taskId: string,
  lineage: string
): JobRecord {
  const grantHash = "grant-hash-" + lineage;
  return Object.freeze({
    id,
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    state: "queued",
    taskId,
    attempt: 0,
    maxAttempts: 5,
    authorizationGrantId: "grant-" + lineage,
    authorizationGrantHash: grantHash,
    authorizationConsumption: {
      id: "consumption-record-" + lineage,
      grantId: "grant-" + lineage,
      grantHash,
      consumerType: "task" as const,
      consumerId: taskId,
      scope,
      planHash: "plan-" + lineage,
      stepHash: "step-" + lineage,
      consumedAt: at,
      consumptionHash: "consumption-hash-" + lineage
    },
    verificationEvidenceIds: Object.freeze([]),
    version: 2,
    updatedAt: at
  });
}

function businessRequest(job: JobRecord): AuthorizedBusinessActionRequest {
  const input = {
    companyId: scope.companyId,
    to: ["fixture@example.test"],
    cc: [],
    subject: "dead-letter unit",
    text: "governed action"
  };
  return Object.freeze({
    id: "request-" + job.id,
    jobId: job.id,
    scope,
    capability: "email.send",
    input,
    inputHash: sha256Hex(input),
    authorizationConsumptionHash: job.authorizationConsumption!.consumptionHash,
    idempotencyKey: "idempotency-" + job.id,
    timeoutMs: 30_000,
    attempt: 1
  });
}

function result<R extends QueryResultRow>(rows: readonly R[], rowCount = rows.length): QueryResult<R> {
  return {
    command: "SELECT",
    rowCount,
    oid: 0,
    fields: [],
    rows: [...rows]
  };
}

interface IdempotencyState {
  key: string;
  fingerprint: string;
  status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  created_at: string;
  completed_at: string | null;
  failed_at: string | null;
  result: unknown;
  error_code: string | null;
}

class FakeDatabase implements PostgresTransactionalDatabase {
  readonly audits: AuditEvent[] = [];
  readonly idempotency = new Map<string, IdempotencyState>();

  constructor(
    readonly runtimeRow: {
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
      scheduled_at: string;
      updated_at: string;
    },
    readonly deadLetter: ReturnType<typeof createDeadLetterRecord>,
    readonly retry: ReturnType<typeof createJobRetryScheduleRecord>,
    readonly transactionReceipt: ReturnType<typeof createJobStoreTransactionReceipt>,
    readonly recovery: ReturnType<typeof createJobRecoveryRecord>,
    readonly outcome: ReturnType<typeof createDurableJobExecutionOutcome>,
    readonly runtimeEvent: ReturnType<typeof createDurableJobRuntimeEvent>,
    readonly provider: BusinessActionExecutionRecord,
    readonly verification: ReturnType<typeof createVerificationEvidence>
  ) {}

  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    return operation(this as unknown as PoolClient);
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<R>> {
    if (text.includes("FROM job_dead_letters d JOIN job_runtime_state")) {
      const latest = this.audits.at(-1) ?? null;
      return result([{
        ...this.runtimeRow,
        dead_letter: this.deadLetter,
        operator_action: latest
      } as unknown as R]);
    }
    if (text.includes("FROM job_runtime_state WHERE job_id")) {
      if (String(values[0]) !== this.runtimeRow.envelope.jobId) return result<R>([]);
      return result([this.runtimeRow as unknown as R]);
    }
    if (text.includes("FROM job_dead_letters WHERE job_id")) {
      return result([{ payload: this.deadLetter } as unknown as R]);
    }
    if (text.includes("FROM job_retry_schedule WHERE job_id")) {
      return result([{ payload: this.retry } as unknown as R]);
    }
    if (text.includes("FROM job_runtime_transactions WHERE job_id")) {
      return result([{ payload: this.transactionReceipt } as unknown as R]);
    }
    if (text.includes("FROM job_recovery_records WHERE job_id")) {
      return result([{ payload: this.recovery } as unknown as R]);
    }
    if (text.includes("FROM job_execution_outcomes WHERE job_id")) {
      return result([{ payload: this.outcome } as unknown as R]);
    }
    if (text.includes("FROM job_runtime_events WHERE job_id")) {
      return result([{ payload: this.runtimeEvent } as unknown as R]);
    }
    if (text.includes("FROM business_action_executions WHERE job_id")) {
      return result([{ payload: this.provider } as unknown as R]);
    }
    if (text.includes("FROM business_action_verification_evidence WHERE job_id")) {
      return result([{ payload: this.verification } as unknown as R]);
    }
    if (text.includes("FROM audit_events WHERE entity_type='job'")) {
      return result(this.audits.map((payload) => ({ payload } as unknown as R)));
    }

    if (text.includes("INSERT INTO idempotency_records")) {
      const key = String(values[0]);
      if (this.idempotency.has(key)) return result<R>([], 0);
      this.idempotency.set(key, {
        key,
        fingerprint: String(values[1]),
        status: "IN_PROGRESS",
        created_at: String(values[2]),
        completed_at: null,
        failed_at: null,
        result: null,
        error_code: null
      });
      return result<R>([], 1);
    }
    if (text.includes("SELECT * FROM idempotency_records WHERE key")) {
      const value = this.idempotency.get(String(values[0]));
      return result(value ? [value as unknown as R] : []);
    }
    if (text.includes("SET status='COMPLETED'")) {
      const value = this.idempotency.get(String(values[0]));
      if (!value || value.fingerprint !== String(values[1])) return result<R>([]);
      value.status = "COMPLETED";
      value.completed_at = String(values[2]);
      value.result = JSON.parse(String(values[3]));
      value.error_code = null;
      return result([value as unknown as R]);
    }
    if (text.includes("SET status='FAILED'")) {
      const value = this.idempotency.get(String(values[0]));
      if (!value || value.fingerprint !== String(values[1])) return result<R>([]);
      value.status = "FAILED";
      value.failed_at = String(values[2]);
      value.error_code = String(values[3]);
      return result([value as unknown as R]);
    }

    if (text.includes("INSERT INTO audit_events")) {
      this.audits.push(JSON.parse(String(values[7])) as AuditEvent);
      return result<R>([], 1);
    }

    throw new Error("Unexpected SQL in dead-letter unit fake: " + text);
  }
}

function fixture() {
  const source = authoritativeJob("job-source", "task-source", "source");
  const replacement = authoritativeJob("job-replacement", "task-replacement", "replacement");
  const competing = authoritativeJob("job-competing", "task-competing", "competing");
  const request = businessRequest(source);
  const spec = createPersistedJobExecutionSpec({
    kind: "business-action",
    jobId: source.id,
    authoritativeJobVersion: source.version,
    authoritativeJobHash: sha256Hex(source),
    request
  }, at);

  const transactionReceipt = createJobStoreTransactionReceipt({
    id: "tx-source",
    operation: "dead-letter",
    jobId: source.id,
    idempotencyKey: "tx-idempotency-source",
    expectedVersion: 3,
    expectedHash: "state-before",
    nextVersion: 4,
    nextHash: "state-after",
    occurredAt: at
  });
  const deadLetter = createDeadLetterRecord({
    id: "dead-source",
    jobId: source.id,
    finalAttempt: 2,
    reason: "provider verification failed",
    failedAt: at,
    sourceEnvelopeHash: "envelope-source",
    transactionHash: transactionReceipt.transactionHash
  });
  const retry = createJobRetryScheduleRecord({
    id: "retry-source",
    jobId: source.id,
    nextAttempt: 2,
    runAt: at,
    reason: "provider pending",
    sourceEnvelopeHash: "envelope-source",
    transactionHash: transactionReceipt.transactionHash
  });
  const recovery = createJobRecoveryRecord({
    id: "recovery-source",
    jobId: source.id,
    recoveredAt: at,
    expiredLeaseHash: "expired-lease",
    transactionHash: transactionReceipt.transactionHash
  });
  const outcome = createDurableJobExecutionOutcome({
    id: "outcome-source",
    jobId: source.id,
    kind: "dead-lettered",
    attempt: 2,
    runtimeState: "dead-lettered",
    reason: "provider verification failed",
    occurredAt: at,
    transactionHash: transactionReceipt.transactionHash
  });
  const runtimeEvent = createDurableJobRuntimeEvent({
    id: "event-source",
    jobId: source.id,
    eventType: "job.dead-lettered",
    attempt: 2,
    occurredAt: at,
    transactionHash: transactionReceipt.transactionHash,
    outcome
  });

  const providerBase = {
    requestId: request.id,
    jobId: source.id,
    requestHash: sha256Hex(request),
    adapterId: "gmail-business-action",
    adapterVersion: "1.1.0",
    providerOperationId: "gmail:gmail-staging:message-source",
    state: "failed" as const,
    adapterResultHash: "adapter-hash",
    latestStatusHash: "status-hash",
    retryable: false,
    retryClass: "provider-4xx" as const,
    updatedAt: at
  };
  const provider: BusinessActionExecutionRecord = Object.freeze({
    ...providerBase,
    recordHash: sha256Hex(providerBase)
  });
  const verification = createVerificationEvidence({
    id: "verification-source",
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    subject: { type: "job", id: source.id },
    strategy: "business",
    result: "fail",
    sourceType: "provider",
    sourceId: provider.providerOperationId!,
    independenceKey: provider.providerOperationId!,
    observedAt: at,
    payloadHash: provider.latestStatusHash!,
    provenance: "dead-letter-unit"
  });

  const runtimeRow = {
    envelope: {
      jobId: source.id,
      taskId: source.taskId,
      envelopeHash: "envelope-source",
      scope: {
        portfolioId: scope.portfolioId,
        companyId: scope.companyId,
        environment: scope.environment
      }
    },
    runtime_state: "dead-lettered",
    version: 4,
    state_hash: "state-after",
    attempt: 2,
    scheduled_at: at,
    updated_at: at
  };
  const db = new FakeDatabase(
    runtimeRow,
    deadLetter,
    retry,
    transactionReceipt,
    recovery,
    outcome,
    runtimeEvent,
    provider,
    verification
  );

  const jobs = new Map<string, JobRecord>([
    [source.id, source],
    [replacement.id, replacement],
    [competing.id, competing]
  ]);
  const specs = new Map<string, PersistedJobExecutionSpec>([[source.id, spec]]);
  const enqueued: JobQueueEnvelope[] = [];
  const cancelled: string[] = [];
  const queue = {
    async getRuntimeSnapshot(jobId: string) {
      if (jobId !== source.id) return null;
      return {
        envelope: {
          ...runtimeRow.envelope,
          scope,
          authorizationConsumptionHash: source.authorizationConsumption!.consumptionHash,
          idempotencyKey: "queue-source",
          scheduledAt: at,
          createdAt: at,
          id: "queue-source"
        },
        state: runtimeRow.runtime_state as "dead-lettered",
        version: runtimeRow.version,
        stateHash: runtimeRow.state_hash,
        attempt: runtimeRow.attempt,
        scheduledAt: runtimeRow.scheduled_at,
        updatedAt: runtimeRow.updated_at
      };
    },
    async enqueue(envelope: JobQueueEnvelope) {
      enqueued.push(envelope);
      return transactionReceipt;
    },
    async cancel(input: { jobId: string }) {
      cancelled.push(input.jobId);
      runtimeRow.runtime_state = "cancelled";
      return transactionReceipt;
    }
  };
  const service = new DeadLetterOperatorService(db, {
    jobs: { get: async (id) => jobs.get(id) ?? null },
    specs: {
      get: async (id) => specs.get(id) ?? null,
      put: async (value) => { specs.set(value.jobId, value); }
    },
    queue,
    now: () => new Date(at)
  });

  return {
    service,
    db,
    source,
    replacement,
    competing,
    request,
    specs,
    enqueued,
    cancelled,
    runtimeRow
  };
}

describe("DeadLetterOperatorService", () => {
  it("projects authoritative failure, retry, provider, verification, and recovery lineage", async () => {
    const f = fixture();
    const list = await f.service.list(principal);
    expect(list).toEqual([
      expect.objectContaining({
        jobId: f.source.id,
        disposition: "open",
        reason: "provider verification failed",
        finalAttempt: 2
      })
    ]);

    const view = await f.service.get(principal, f.source.id);
    expect(view).toMatchObject({
      jobId: f.source.id,
      taskId: f.source.taskId,
      disposition: "open",
      runtime: { state: "dead-lettered", attempt: 2 },
      authoritativeJob: {
        authorizationGrantId: f.source.authorizationGrantId,
        authorizationConsumptionHash: f.source.authorizationConsumption?.consumptionHash
      },
      retrySafety: {
        automaticRedriveSupported: true,
        requiresDifferentJob: true,
        requiresFreshAuthorizationLineage: true,
        reusesOldProviderOperation: false
      }
    });
    expect(view?.retries).toHaveLength(1);
    expect(view?.transactions).toHaveLength(1);
    expect(view?.recoveries).toHaveLength(1);
    expect(view?.outcomes).toHaveLength(1);
    expect(view?.runtimeEvents).toHaveLength(1);
    expect(view?.providerEvidence[0]?.providerOperationId).toContain("message-source");
    expect(view?.verificationEvidence[0]?.result).toBe("fail");
    expect(view?.executionSpec?.request?.id).toBe(f.request.id);
    expect(view?.lineageHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(f.service.get(principal, "missing")).resolves.toBeNull();
  });

  it("dismisses idempotently and records the owner/admin decision without provider replay", async () => {
    const f = fixture();
    const input = {
      action: "dismiss" as const,
      reason: "obsolete work",
      idempotencyKey: "dismiss-unit-0001"
    };
    const first = await f.service.act(principal, f.source.id, input);
    const replay = await f.service.act(principal, f.source.id, input);
    expect(replay).toEqual(first);
    expect(f.enqueued).toHaveLength(0);
    expect(f.cancelled).toHaveLength(0);
    expect(f.db.audits).toHaveLength(1);
    expect(f.db.audits[0]).toMatchObject({
      eventType: "dead-letter.operator.dismissed",
      metadata: {
        oldProviderReplay: false,
        freshAuthorizationRequired: false
      }
    });
    expect((await f.service.get(principal, f.source.id))?.disposition).toBe("dismissed");
  });

  it("cancels through the durable queue compare-and-swap path and remains idempotent", async () => {
    const f = fixture();
    const input = {
      action: "cancel" as const,
      reason: "owner cancelled",
      idempotencyKey: "cancel-unit-0001"
    };
    expect((await f.service.act(principal, f.source.id, input)).action).toBe("cancel");
    expect(f.cancelled).toEqual([f.source.id]);
    expect(f.runtimeRow.runtime_state).toBe("cancelled");
    expect((await f.service.get(principal, f.source.id))?.disposition).toBe("cancelled");
    expect((await f.service.act(principal, f.source.id, input)).action).toBe("cancel");
    expect(f.cancelled).toHaveLength(1);
  });

  it("redrives into one different fresh authorization lineage and never reuses the source provider operation", async () => {
    const f = fixture();
    const input = {
      action: "retry" as const,
      reason: "owner approved fresh lineage",
      replacementJobId: f.replacement.id,
      idempotencyKey: "retry-unit-0001"
    };
    const first = await f.service.act(principal, f.source.id, input);
    const replay = await f.service.act(principal, f.source.id, input);
    expect(replay).toEqual(first);
    expect(first.replacementJobId).toBe(f.replacement.id);
    expect(first.requestId).not.toBe(f.request.id);
    expect(f.enqueued).toHaveLength(1);
    expect(f.enqueued[0].jobId).toBe(f.replacement.id);

    const replacementSpec = f.specs.get(f.replacement.id);
    expect(replacementSpec?.spec.kind).toBe("business-action");
    if (replacementSpec?.spec.kind !== "business-action") throw new Error("missing replacement business spec");
    expect(replacementSpec.spec.request.authorizationConsumptionHash)
      .toBe(f.replacement.authorizationConsumption?.consumptionHash);
    expect(replacementSpec.spec.request.idempotencyKey).not.toBe(f.request.idempotencyKey);
    expect(f.db.audits[0]).toMatchObject({
      eventType: "dead-letter.operator.redriven",
      metadata: {
        replacementJobId: f.replacement.id,
        oldProviderReplay: false,
        freshAuthorizationRequired: true
      }
    });

    await expect(f.service.act(principal, f.source.id, {
      ...input,
      replacementJobId: f.competing.id,
      idempotencyKey: "retry-unit-0002"
    })).rejects.toThrow(/different redrive lineage/i);
    expect(f.enqueued).toHaveLength(1);
  });

  it("rejects unsafe redrives and roles without execution authority", async () => {
    const f = fixture();
    expect(() => f.service.list({ ...principal, role: "operator" })).toThrow(/owner or admin/i);
    expect(() => f.service.get({ ...principal, role: "viewer" }, f.source.id)).toThrow(/owner or admin/i);
    expect(() => f.service.act(
      { ...principal, role: "operator" },
      f.source.id,
      {
        action: "dismiss",
        reason: "not allowed",
        idempotencyKey: "role-unit-0001"
      }
    )).toThrow(/owner or admin/i);

    await expect(f.service.act(principal, f.source.id, {
      action: "retry",
      reason: "same Job is forbidden",
      replacementJobId: f.source.id,
      idempotencyKey: "unsafe-unit-0001"
    })).rejects.toThrow(/different replacement Job/i);

    const reused = authoritativeJob("job-reused", "task-reused", "source");
    const jobs = new Map<string, JobRecord>([
      [f.source.id, f.source],
      [reused.id, reused]
    ]);
    const sourceSpec = f.specs.get(f.source.id)!;
    const service = new DeadLetterOperatorService(f.db, {
      jobs: { get: async (id) => jobs.get(id) ?? null },
      specs: {
        get: async (id) => id === f.source.id ? sourceSpec : null,
        put: async () => undefined
      },
      queue: {
        getRuntimeSnapshot: async () => null,
        enqueue: async () => { throw new Error("must not enqueue"); },
        cancel: async () => { throw new Error("must not cancel"); }
      },
      now: () => new Date(at)
    });
    await expect(service.act(principal, f.source.id, {
      action: "retry",
      reason: "old authorization is forbidden",
      replacementJobId: reused.id,
      idempotencyKey: "unsafe-unit-0002"
    })).rejects.toThrow(/fresh authorization lineage/i);
  });
});
