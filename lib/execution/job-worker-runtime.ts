import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  createDeadLetterRecord,
  createJobRetryScheduleRecord,
  type DurableJobLease,
  type JobQueueEnvelope,
  type JobStoreTransactionReceipt
} from "@/lib/execution/job-runtime-contracts";
import type {
  DurableJobCandidate,
  DurableJobWorkStore
} from "@/lib/persistence/postgres/job-store";

export type JobExecutionOutcome =
  | { kind: "succeeded" }
  | { kind: "retry"; reason: string; delayMs?: number }
  | { kind: "dead-letter"; reason: string }
  | { kind: "cancelled"; reason: string };

export interface DurableJobExecutionContext {
  envelope: JobQueueEnvelope;
  lease: DurableJobLease;
  heartbeat(): Promise<void>;
  runtimeVersion(): number;
  runtimeHash(): string;
}

export interface DurableJobExecutionHandler {
  execute(context: DurableJobExecutionContext): Promise<JobExecutionOutcome>;
}

export interface DurableJobWorkerConfig {
  workerId: string;
  leaseSeconds?: number;
  heartbeatSeconds?: number;
  batchSize?: number;
  retryBaseDelayMs?: number;
  maxAttempts?: number;
}

export class DurableJobWorker {
  private readonly leaseSeconds: number;
  private readonly heartbeatSeconds: number;
  private readonly batchSize: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly store: DurableJobWorkStore,
    private readonly config: DurableJobWorkerConfig,
    private readonly now: () => Date = () => new Date()
  ) {
    if (!config.workerId.trim()) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Durable Job workerId is required");
    }
    this.leaseSeconds = config.leaseSeconds ?? 60;
    this.heartbeatSeconds = config.heartbeatSeconds ?? 20;
    this.batchSize = config.batchSize ?? 10;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 1_000;
    this.maxAttempts = config.maxAttempts ?? 5;
    if (
      !Number.isInteger(this.leaseSeconds)
      || this.leaseSeconds < 2
      || !Number.isInteger(this.heartbeatSeconds)
      || this.heartbeatSeconds < 1
      || !Number.isInteger(this.batchSize)
      || this.batchSize < 1
      || !Number.isInteger(this.maxAttempts)
      || this.maxAttempts < 1
      || !Number.isFinite(this.retryBaseDelayMs)
      || this.retryBaseDelayMs < 0
    ) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Durable Job worker timing, batch size, and retry limits are invalid"
      );
    }
    if (this.heartbeatSeconds >= this.leaseSeconds) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Heartbeat interval must be shorter than the Job lease"
      );
    }
  }

  async runOnce(handler: DurableJobExecutionHandler) {
    const at = this.now().toISOString();
    const candidates = await this.store.listReady({ now: at, limit: this.batchSize });
    const results: Array<{ jobId: string; outcome: JobExecutionOutcome }> = [];
    for (const candidate of candidates) {
      const result = await this.runCandidate(candidate, handler);
      if (result) results.push(result);
    }
    return results;
  }

  async recoverExpired(limit = this.batchSize) {
    return this.store.recoverExpired({
      now: this.now().toISOString(),
      limit
    });
  }

  async cancel(jobId: string, reason: string) {
    const snapshot = await this.store.getRuntimeSnapshot(jobId);
    if (!snapshot) throw new ControlPlaneError("NOT_FOUND", "Durable Job runtime state was not found");
    return this.store.cancel({
      jobId,
      reason,
      cancelledAt: this.now().toISOString(),
      expectedJobVersion: snapshot.version,
      expectedJobHash: snapshot.stateHash,
      idempotencyKey: `cancel:${jobId}:${snapshot.version}`
    });
  }

  private async runCandidate(
    candidate: DurableJobCandidate,
    handler: DurableJobExecutionHandler
  ) {
    const claim = await this.store.claimAtomic({
      jobId: candidate.envelope.jobId,
      workerId: this.config.workerId,
      now: this.now().toISOString(),
      leaseSeconds: this.leaseSeconds,
      expectedJobVersion: candidate.version,
      expectedJobHash: candidate.stateHash,
      idempotencyKey: `claim:${candidate.envelope.jobId}:${candidate.version}:${this.config.workerId}`
    });
    if (!claim) return null;

    let lease = claim.lease;
    let version = claim.transaction.nextVersion;
    let stateHash = claim.transaction.nextHash;
    let latestTransaction: JobStoreTransactionReceipt = claim.transaction;
    let heartbeatBusy = false;
    let stopped = false;

    const heartbeat = async () => {
      if (stopped || heartbeatBusy) return;
      heartbeatBusy = true;
      try {
        const renewed = await this.store.heartbeat({
          lease,
          now: this.now().toISOString(),
          extendSeconds: this.leaseSeconds,
          expectedJobVersion: version,
          expectedJobHash: stateHash,
          idempotencyKey: `heartbeat:${lease.id}:${lease.version}`
        });
        lease = renewed.lease;
        version = renewed.transaction.nextVersion;
        stateHash = renewed.transaction.nextHash;
        latestTransaction = renewed.transaction;
      } finally {
        heartbeatBusy = false;
      }
    };

    const timer = setInterval(() => {
      void heartbeat().catch(() => {
        stopped = true;
      });
    }, this.heartbeatSeconds * 1_000);
    timer.unref?.();

    let outcome: JobExecutionOutcome;
    try {
      outcome = await handler.execute({
        envelope: candidate.envelope,
        get lease() { return lease; },
        heartbeat,
        runtimeVersion: () => version,
        runtimeHash: () => stateHash
      });
    } catch (error) {
      outcome = {
        kind: "retry",
        reason: error instanceof Error ? error.message : "Unhandled worker execution failure"
      };
    } finally {
      stopped = true;
      clearInterval(timer);
      while (heartbeatBusy) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }

    if (outcome.kind === "succeeded") {
      const receipt = await this.store.release({
        lease,
        now: this.now().toISOString(),
        expectedJobVersion: version,
        expectedJobHash: stateHash,
        idempotencyKey: `release:${lease.id}:${lease.version}`
      });
      latestTransaction = receipt;
    } else if (outcome.kind === "cancelled") {
      const receipt = await this.store.cancel({
        jobId: candidate.envelope.jobId,
        reason: outcome.reason,
        cancelledAt: this.now().toISOString(),
        expectedJobVersion: version,
        expectedJobHash: stateHash,
        idempotencyKey: `cancel:${candidate.envelope.jobId}:${version}`
      });
      latestTransaction = receipt;
    } else if (outcome.kind === "dead-letter") {
      const record = createDeadLetterRecord({
        id: crypto.randomUUID(),
        jobId: candidate.envelope.jobId,
        finalAttempt: lease.attempt,
        reason: outcome.reason,
        failedAt: this.now().toISOString(),
        sourceEnvelopeHash: candidate.envelope.envelopeHash,
        transactionHash: latestTransaction.transactionHash
      });
      latestTransaction = await this.store.deadLetter(record);
    } else if (lease.attempt >= this.maxAttempts) {
      const record = createDeadLetterRecord({
        id: crypto.randomUUID(),
        jobId: candidate.envelope.jobId,
        finalAttempt: lease.attempt,
        reason: `maximum attempts reached: ${outcome.reason}`,
        failedAt: this.now().toISOString(),
        sourceEnvelopeHash: candidate.envelope.envelopeHash,
        transactionHash: latestTransaction.transactionHash
      });
      latestTransaction = await this.store.deadLetter(record);
      outcome = { kind: "dead-letter", reason: record.reason };
    } else {
      const delay = outcome.delayMs ?? this.retryBaseDelayMs * 2 ** Math.max(0, lease.attempt - 1);
      const record = createJobRetryScheduleRecord({
        id: crypto.randomUUID(),
        jobId: candidate.envelope.jobId,
        nextAttempt: lease.attempt + 1,
        runAt: new Date(this.now().getTime() + delay).toISOString(),
        reason: outcome.reason,
        sourceEnvelopeHash: candidate.envelope.envelopeHash,
        transactionHash: latestTransaction.transactionHash
      });
      latestTransaction = await this.store.scheduleRetry(record);
    }

    return { jobId: candidate.envelope.jobId, outcome };
  }
}
