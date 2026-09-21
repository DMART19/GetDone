import { describe, expect, it } from "vitest";
import {
  assertDurableJobLease,
  assertJobStoreTransactionReceipt,
  assertProductionDurableJobStoreDescriptor,
  createDeadLetterRecord,
  createDurableJobLease,
  createJobQueueEnvelope,
  createJobRecoveryRecord,
  createJobRetryScheduleRecord,
  createJobStoreTransactionReceipt,
  renewDurableJobLease
} from "@/lib/execution/job-runtime-contracts";

const scope = {
  userId: "owner",
  portfolioId: "portfolio",
  companyId: "company",
  environment: "production" as const
};

function transaction(operation: "enqueue" | "retry" | "dead-letter" | "recover-expired") {
  return createJobStoreTransactionReceipt({
    id: `tx-${operation}`,
    operation,
    jobId: "job-1",
    idempotencyKey: `job-1:${operation}`,
    expectedVersion: 1,
    expectedHash: "state-hash-v1",
    nextVersion: 2,
    nextHash: `state-hash-v2:${operation}`,
    occurredAt: "2026-09-20T22:10:00Z"
  });
}

describe("Phase 19 durable Job Engine contracts", () => {
  it("binds durable enqueue to authorization consumption and idempotency", () => {
    const envelope = createJobQueueEnvelope({
      id: "queue-1",
      jobId: "job-1",
      taskId: "task-1",
      scope,
      authorizationConsumptionHash: "auth-consumption-hash",
      idempotencyKey: "queue:job-1",
      scheduledAt: "2026-09-20T22:00:00Z",
      createdAt: "2026-09-20T22:00:00Z"
    });
    expect(envelope.envelopeHash).toHaveLength(64);
  });

  it("uses leased worker claims with heartbeat renewal", () => {
    const lease = createDurableJobLease({
      id: "lease-1",
      jobId: "job-1",
      workerId: "worker-a",
      attempt: 1,
      leaseIssuedAt: "2026-09-20T22:00:00Z",
      leaseSeconds: 60
    });
    expect(assertDurableJobLease(lease, {
      jobId: "job-1",
      workerId: "worker-a",
      now: Date.parse("2026-09-20T22:00:30Z")
    })).toBe(lease);
    const renewed = renewDurableJobLease(lease, {
      now: "2026-09-20T22:00:30Z",
      extendSeconds: 60
    });
    expect(renewed.version).toBe(2);
    expect(renewed.expiresAt).toBe("2026-09-20T22:01:30.000Z");
  });

  it("rejects stale leases for crash-safe recovery", () => {
    const lease = createDurableJobLease({
      id: "lease-1",
      jobId: "job-1",
      workerId: "worker-a",
      attempt: 1,
      leaseIssuedAt: "2026-09-20T22:00:00Z",
      leaseSeconds: 30
    });
    expect(() => assertDurableJobLease(lease, {
      jobId: "job-1",
      now: Date.parse("2026-09-20T22:01:00Z")
    })).toThrow(/stale/i);
  });

  it("requires hash-bound single-version transaction receipts for runtime mutations", () => {
    const receipt = transaction("enqueue");
    expect(assertJobStoreTransactionReceipt(receipt)).toBe(receipt);
    expect(receipt.transactionHash).toHaveLength(64);
    expect(() => createJobStoreTransactionReceipt({
      id: "bad",
      operation: "retry",
      jobId: "job-1",
      idempotencyKey: "retry",
      expectedVersion: 1,
      expectedHash: "same",
      nextVersion: 3,
      nextHash: "other",
      occurredAt: "2026-09-20T22:10:00Z"
    })).toThrow(/version/i);
  });

  it("hash-binds retry, dead-letter, and recovery records to transaction lineage", () => {
    const retryTx = transaction("retry");
    const retry = createJobRetryScheduleRecord({
      id: "retry-1",
      jobId: "job-1",
      nextAttempt: 2,
      runAt: "2026-09-20T22:11:00Z",
      reason: "provider timeout",
      sourceEnvelopeHash: "envelope-hash",
      transactionHash: retryTx.transactionHash
    });
    const deadTx = transaction("dead-letter");
    const dead = createDeadLetterRecord({
      id: "dead-1",
      jobId: "job-1",
      finalAttempt: 5,
      reason: "max attempts reached",
      failedAt: "2026-09-20T22:12:00Z",
      sourceEnvelopeHash: "envelope-hash",
      transactionHash: deadTx.transactionHash
    });
    const recoveryTx = transaction("recover-expired");
    const recovery = createJobRecoveryRecord({
      id: "recovery-1",
      jobId: "job-1",
      expiredLeaseHash: "expired-lease-hash",
      outcome: "retry-scheduled",
      recoveredAt: "2026-09-20T22:13:00Z",
      transactionHash: recoveryTx.transactionHash
    });
    expect(retry.recordHash).toHaveLength(64);
    expect(dead.recordHash).toHaveLength(64);
    expect(recovery.recordHash).toHaveLength(64);
  });

  it("does not allow an ephemeral reference store descriptor to pose as production durable", () => {
    expect(() => assertProductionDurableJobStoreDescriptor({
      persistence: "ephemeral-reference",
      atomicClaims: true,
      compareAndSwap: true,
      restartSafe: false,
      multiProcessSafe: false,
      productionEligible: false
    })).toThrow(/Production Job Store/i);

    expect(assertProductionDurableJobStoreDescriptor({
      persistence: "durable-external",
      atomicClaims: true,
      compareAndSwap: true,
      restartSafe: true,
      multiProcessSafe: true,
      productionEligible: true
    }).productionEligible).toBe(true);
  });
});
