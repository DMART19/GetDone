import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { ControlApiPrincipal } from "@/lib/control-api/contracts";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import {
  type BusinessActionExecutionRecord
} from "@/lib/execution/business-action-orchestrator";
import { DeadLetterOperatorService } from "@/lib/execution/dead-letter-operator.server";
import { createPersistedJobExecutionSpec } from "@/lib/execution/job-execution-router";
import {
  createDeadLetterRecord,
  createJobQueueEnvelope,
  createJobRetryScheduleRecord
} from "@/lib/execution/job-runtime-contracts";
import { PostgresEntityStore } from "@/lib/persistence/postgres/authority-stores";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresBusinessActionExecutionStore } from "@/lib/persistence/postgres/execution-stores";
import { PostgresJobExecutionSpecStore } from "@/lib/persistence/postgres/job-execution-spec-store";
import { PostgresDurableJobStore } from "@/lib/persistence/postgres/job-store";
import { PostgresJobVerificationEvidenceStore } from "@/lib/persistence/postgres/worker-runtime-stores";
import { createVerificationEvidence } from "@/lib/verification/verification";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const integrationDescribe = enabled ? describe.sequential : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "";

const scope = Object.freeze({
  userId: "owner-dead-letter",
  portfolioId: "portfolio-dead-letter",
  companyId: "company-dead-letter",
  environment: "staging" as const
});

const principal: ControlApiPrincipal = Object.freeze({
  actor: { type: "user" as const, id: scope.userId },
  scope,
  sessionId: "session-dead-letter",
  role: "owner"
});

function database() {
  return new PostgresDatabase({
    connectionString: databaseUrl,
    maxConnections: 4,
    ssl: process.env.GETDONE_DB_SSL !== "false"
  });
}

function job(id: string, taskId: string, lineage: string, at: string): JobRecord {
  return Object.freeze({
    id,
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    state: "queued",
    taskId,
    attempt: 0,
    maxAttempts: 5,
    authorizationGrantId: "grant-" + lineage,
    authorizationGrantHash: "grant-hash-" + lineage,
    authorizationConsumption: {
      id: "consumption-record-" + lineage,
      grantId: "grant-" + lineage,
      grantHash: "grant-hash-" + lineage,
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

function request(source: JobRecord): AuthorizedBusinessActionRequest {
  const input = {
    companyId: source.companyId,
    to: ["operator-fixture@example.test"],
    cc: [],
    subject: "dead-letter acceptance",
    text: "governed provider action"
  };
  return Object.freeze({
    id: "request-" + source.id,
    jobId: source.id,
    scope,
    capability: "email.send",
    input,
    inputHash: sha256Hex(input),
    authorizationConsumptionHash: source.authorizationConsumption!.consumptionHash,
    idempotencyKey: "idempotency-" + source.id,
    timeoutMs: 30_000,
    attempt: 1
  });
}

async function seedDeadLetter(
  db: PostgresDatabase,
  id: string,
  lineage = id
) {
  const at = "2026-09-23T20:00:00.000Z";
  const authoritative = job(id, "task-" + id, lineage, at);
  const action = request(authoritative);
  const jobs = new PostgresEntityStore<JobRecord>(db, "job");
  const specs = new PostgresJobExecutionSpecStore(db);
  const queue = new PostgresDurableJobStore(db);
  await jobs.create(authoritative);
  await specs.put(createPersistedJobExecutionSpec({
    kind: "business-action",
    jobId: authoritative.id,
    authoritativeJobVersion: authoritative.version,
    authoritativeJobHash: sha256Hex(authoritative),
    request: action
  }, at));

  const envelope = createJobQueueEnvelope({
    id: "queue:" + id,
    jobId: id,
    taskId: authoritative.taskId,
    scope,
    authorizationConsumptionHash: authoritative.authorizationConsumption!.consumptionHash,
    idempotencyKey: "queue:" + id,
    scheduledAt: at,
    createdAt: at
  });
  await queue.enqueue(envelope);

  const firstCandidate = (await queue.listReady({
    now: "2026-09-23T20:00:01.000Z",
    limit: 1
  }))[0];
  const firstClaim = await queue.claimAtomic({
    jobId: id,
    workerId: "worker-dead-letter-a",
    now: "2026-09-23T20:00:01.000Z",
    leaseSeconds: 10,
    expectedJobVersion: firstCandidate.version,
    expectedJobHash: firstCandidate.stateHash,
    idempotencyKey: "claim:first:" + id
  });
  if (!firstClaim) throw new Error("first claim failed");

  const retry = createJobRetryScheduleRecord({
    id: "retry:" + id,
    jobId: id,
    nextAttempt: 2,
    runAt: "2026-09-23T20:00:02.000Z",
    reason: "transient provider failure",
    sourceEnvelopeHash: envelope.envelopeHash,
    transactionHash: firstClaim.transaction.transactionHash
  });
  await queue.scheduleRetry(retry);

  const secondCandidate = (await queue.listReady({
    now: "2026-09-23T20:00:03.000Z",
    limit: 1
  }))[0];
  const secondClaim = await queue.claimAtomic({
    jobId: id,
    workerId: "worker-dead-letter-b",
    now: "2026-09-23T20:00:03.000Z",
    leaseSeconds: 10,
    expectedJobVersion: secondCandidate.version,
    expectedJobHash: secondCandidate.stateHash,
    idempotencyKey: "claim:second:" + id
  });
  if (!secondClaim) throw new Error("second claim failed");

  await queue.deadLetter(createDeadLetterRecord({
    id: "dead:" + id,
    jobId: id,
    finalAttempt: 2,
    reason: "verification failed",
    failedAt: "2026-09-23T20:00:04.000Z",
    sourceEnvelopeHash: envelope.envelopeHash,
    transactionHash: secondClaim.transaction.transactionHash
  }));

  const providerBase = {
    requestId: action.id,
    jobId: id,
    requestHash: sha256Hex(action),
    adapterId: "gmail",
    adapterVersion: "1.0.0",
    providerOperationId: "gmail:gmail-staging:provider-message-" + id,
    state: "failed" as const,
    adapterResultHash: sha256Hex({ id, kind: "adapter-result" }),
    latestStatusHash: sha256Hex({ id, kind: "provider-status" }),
    retryable: false,
    retryClass: "provider-4xx" as const,
    updatedAt: "2026-09-23T20:00:04.000Z"
  };
  const provider: BusinessActionExecutionRecord = Object.freeze({
    ...providerBase,
    recordHash: sha256Hex(providerBase)
  });
  await new PostgresBusinessActionExecutionStore(db).save(provider);

  const evidence = createVerificationEvidence({
    id: "evidence:" + id,
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    subject: { type: "job", id },
    strategy: "business",
    result: "fail",
    sourceType: "provider",
    sourceId: provider.providerOperationId!,
    independenceKey: provider.providerOperationId!,
    observedAt: "2026-09-23T20:00:04.000Z",
    payloadHash: provider.latestStatusHash!,
    provenance: "dead-letter-operator-acceptance"
  });
  await new PostgresJobVerificationEvidenceStore(db).put(id, action.id, evidence);
  return { authoritative, action, queue, jobs, specs };
}

integrationDescribe("dead-letter owner/admin PostgreSQL acceptance", () => {
  const db = database();

  beforeEach(async () => {
    await db.query(`TRUNCATE
      business_action_verification_evidence,
      business_action_executions,
      job_runtime_events,
      job_execution_outcomes,
      job_recovery_records,
      job_dead_letters,
      job_retry_schedule,
      job_runtime_transactions,
      job_leases,
      job_runtime_state,
      job_execution_specs,
      audit_events,
      idempotency_records,
      control_plane_entities
      RESTART IDENTITY CASCADE`);
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  it("shows failure lineage and redrives only through a different freshly authorized Job", async () => {
    const source = await seedDeadLetter(db, "job-dead-source", "source-lineage");
    const replacement = job(
      "job-dead-replacement",
      "task-dead-replacement",
      "replacement-lineage",
      "2026-09-23T20:01:00.000Z"
    );
    await source.jobs.create(replacement);

    const service = new DeadLetterOperatorService(db, {
      jobs: source.jobs,
      specs: source.specs,
      queue: source.queue,
      now: () => new Date("2026-09-23T20:01:01.000Z")
    });

    const before = await service.get(principal, source.authoritative.id);
    expect(before).toMatchObject({
      disposition: "open",
      retrySafety: {
        automaticRedriveSupported: true,
        reusesOldProviderOperation: false
      }
    });
    expect(before?.retries).toHaveLength(1);
    expect(before?.providerEvidence[0]?.providerOperationId)
      .toContain("provider-message-job-dead-source");
    expect(before?.verificationEvidence[0]?.result).toBe("fail");

    const action = {
      action: "retry" as const,
      reason: "owner approved new authorization lineage",
      replacementJobId: replacement.id,
      idempotencyKey: "operator-redrive-0001"
    };
    const first = await service.act(principal, source.authoritative.id, action);
    const replay = await service.act(principal, source.authoritative.id, action);
    expect(replay).toEqual(first);
    expect(first.replacementJobId).toBe(replacement.id);
    expect(first.requestId).not.toBe(source.action.id);

    const replacementSpec = await source.specs.get(replacement.id);
    expect(replacementSpec?.spec.kind).toBe("business-action");
    if (replacementSpec?.spec.kind !== "business-action") {
      throw new Error("replacement spec was not a business action");
    }
    expect(replacementSpec.spec.request.authorizationConsumptionHash)
      .toBe(replacement.authorizationConsumption?.consumptionHash);
    expect(replacementSpec.spec.request.idempotencyKey)
      .not.toBe(source.action.idempotencyKey);
    expect(await source.queue.getRuntimeSnapshot(replacement.id)).toMatchObject({
      state: "queued",
      attempt: 0
    });

    const providerCount = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM business_action_executions WHERE job_id=$1",
      [source.authoritative.id]
    );
    expect(Number(providerCount.rows[0].count)).toBe(1);

    const after = await service.get(principal, source.authoritative.id);
    expect(after?.disposition).toBe("redriven");
    expect(after?.operatorActions.at(-1)).toMatchObject({
      eventType: "dead-letter.operator.redriven",
      replacementJobId: replacement.id,
      requestId: first.requestId
    });
  });

  it("rejects source-lineage reuse, competing replacement lineage, and non-owner/admin access", async () => {
    const source = await seedDeadLetter(db, "job-dead-guard", "guard-source");
    const reused = job(
      "job-dead-reused-lineage",
      "task-dead-reused-lineage",
      "guard-source",
      "2026-09-23T20:02:00.000Z"
    );
    const replacement = job(
      "job-dead-fresh-lineage",
      "task-dead-fresh-lineage",
      "guard-fresh",
      "2026-09-23T20:02:00.000Z"
    );
    const competing = job(
      "job-dead-competing-lineage",
      "task-dead-competing-lineage",
      "guard-competing",
      "2026-09-23T20:02:00.000Z"
    );
    await source.jobs.create(reused);
    await source.jobs.create(replacement);
    await source.jobs.create(competing);
    const service = new DeadLetterOperatorService(db, {
      jobs: source.jobs,
      specs: source.specs,
      queue: source.queue,
      now: () => new Date("2026-09-23T20:02:01.000Z")
    });

    await expect(service.act(principal, source.authoritative.id, {
      action: "retry",
      reason: "unsafe",
      replacementJobId: reused.id,
      idempotencyKey: "operator-redrive-unsafe"
    })).rejects.toThrow(/fresh authorization lineage/i);

    await service.act(principal, source.authoritative.id, {
      action: "retry",
      reason: "approved",
      replacementJobId: replacement.id,
      idempotencyKey: "operator-redrive-approved"
    });

    await expect(service.act(principal, source.authoritative.id, {
      action: "retry",
      reason: "try second target",
      replacementJobId: competing.id,
      idempotencyKey: "operator-redrive-second"
    })).rejects.toThrow(/different redrive lineage/i);

    await expect(service.list({
      ...principal,
      role: "operator"
    })).rejects.toThrow(/owner or admin/i);
  });

  it("supports idempotent dismiss and cancellation without replaying provider work", async () => {
    const dismissed = await seedDeadLetter(db, "job-dead-dismiss", "dismiss-lineage");
    const service = new DeadLetterOperatorService(db, {
      jobs: dismissed.jobs,
      specs: dismissed.specs,
      queue: dismissed.queue,
      now: () => new Date("2026-09-23T20:03:00.000Z")
    });
    const dismissInput = {
      action: "dismiss" as const,
      reason: "known obsolete work",
      idempotencyKey: "operator-dismiss-0001"
    };
    expect(await service.act(principal, dismissed.authoritative.id, dismissInput))
      .toEqual(await service.act(principal, dismissed.authoritative.id, dismissInput));
    expect((await service.get(principal, dismissed.authoritative.id))?.disposition)
      .toBe("dismissed");

    const cancelled = await seedDeadLetter(db, "job-dead-cancel", "cancel-lineage");
    const cancelInput = {
      action: "cancel" as const,
      reason: "owner cancelled terminal work",
      idempotencyKey: "operator-cancel-0001"
    };
    expect((await service.act(principal, cancelled.authoritative.id, cancelInput)).action)
      .toBe("cancel");
    expect((await cancelled.queue.getRuntimeSnapshot(cancelled.authoritative.id))?.state)
      .toBe("cancelled");
    expect((await service.get(principal, cancelled.authoritative.id))?.disposition)
      .toBe("cancelled");
  });
});
