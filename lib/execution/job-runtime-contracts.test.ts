import { describe, expect, it } from "vitest";
import {
  assertDurableJobLease,
  createDeadLetterRecord,
  createDurableJobLease,
  createJobQueueEnvelope,
  renewDurableJobLease
} from "@/lib/execution/job-runtime-contracts";

const scope = {
  userId: "owner",
  portfolioId: "portfolio",
  companyId: "company",
  environment: "production" as const
};

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

  it("creates hash-bound dead-letter evidence rather than dropping exhausted work", () => {
    const record = createDeadLetterRecord({
      id: "dead-1",
      jobId: "job-1",
      finalAttempt: 5,
      reason: "max attempts reached",
      failedAt: "2026-09-20T22:10:00Z",
      sourceEnvelopeHash: "envelope-hash"
    });
    expect(record.recordHash).toHaveLength(64);
  });
});
