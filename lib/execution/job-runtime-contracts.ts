import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export const JOB_RUNTIME_CONTRACT_VERSION = "1.0.0";

export interface JobQueueEnvelope {
  id: string;
  jobId: string;
  taskId: string;
  scope: TrustedExecutionScope;
  authorizationConsumptionHash: string;
  idempotencyKey: string;
  scheduledAt: string;
  createdAt: string;
  envelopeHash: string;
}

export type JobLeaseState = "active" | "released" | "expired";

export interface DurableJobLease {
  id: string;
  jobId: string;
  workerId: string;
  attempt: number;
  leaseIssuedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  state: JobLeaseState;
  version: number;
  leaseHash: string;
}

export interface DeadLetterRecord {
  id: string;
  jobId: string;
  finalAttempt: number;
  reason: string;
  failedAt: string;
  sourceEnvelopeHash: string;
  recordHash: string;
}

export interface JobRuntimeMutation {
  operation:
    | "enqueue"
    | "claim"
    | "heartbeat"
    | "release"
    | "retry"
    | "dead-letter"
    | "cancel"
    | "recover-expired";
  jobId: string;
  expectedVersion?: number;
  expectedHash?: string;
  nextVersion: number;
  nextHash: string;
  idempotencyKey: string;
  mutationHash: string;
}

/**
 * Production implementation requirement.
 *
 * The store must be durable and atomic across process restarts. No in-memory
 * implementation is provided or accepted as production evidence.
 */
export interface DurableJobStore {
  enqueue(input: JobQueueEnvelope): Promise<"enqueued" | "idempotent-replay">;
  claimAtomic(input: {
    jobId: string;
    workerId: string;
    now: string;
    leaseSeconds: number;
    expectedJobVersion: number;
  }): Promise<DurableJobLease | null>;
  heartbeat(input: {
    lease: DurableJobLease;
    now: string;
    extendSeconds: number;
  }): Promise<DurableJobLease>;
  release(input: { lease: DurableJobLease; now: string }): Promise<void>;
  scheduleRetry(input: {
    envelope: JobQueueEnvelope;
    nextAttempt: number;
    runAt: string;
    reason: string;
  }): Promise<void>;
  deadLetter(record: DeadLetterRecord): Promise<void>;
  cancel(input: { jobId: string; reason: string; cancelledAt: string }): Promise<void>;
  recoverExpired(input: { now: string; limit: number }): Promise<readonly string[]>;
}

function parse(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a timestamp`);
  }
  return parsed;
}

export function createJobQueueEnvelope(
  input: Omit<JobQueueEnvelope, "envelopeHash">
): JobQueueEnvelope {
  if (!input.authorizationConsumptionHash || !input.idempotencyKey) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Durable job enqueue requires authorization consumption and idempotency lineage"
    );
  }
  const scheduledAt = parse(input.scheduledAt, "scheduledAt");
  const createdAt = parse(input.createdAt, "createdAt");
  if (scheduledAt < createdAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "scheduledAt cannot precede createdAt");
  }
  const base = {
    ...input,
    scheduledAt: new Date(scheduledAt).toISOString(),
    createdAt: new Date(createdAt).toISOString()
  };
  return Object.freeze({ ...base, envelopeHash: sha256Hex(base) });
}

export function createDurableJobLease(input: {
  id: string;
  jobId: string;
  workerId: string;
  attempt: number;
  leaseIssuedAt: string;
  leaseSeconds: number;
}): DurableJobLease {
  if (!input.workerId || !Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Worker identity and positive attempt are required");
  }
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Positive leaseSeconds are required");
  }
  const issued = parse(input.leaseIssuedAt, "leaseIssuedAt");
  const base = {
    id: input.id,
    jobId: input.jobId,
    workerId: input.workerId,
    attempt: input.attempt,
    leaseIssuedAt: new Date(issued).toISOString(),
    heartbeatAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + input.leaseSeconds * 1000).toISOString(),
    state: "active" as const,
    version: 1
  };
  return Object.freeze({ ...base, leaseHash: sha256Hex(base) });
}

export function assertDurableJobLease(
  lease: DurableJobLease,
  input: { jobId: string; workerId?: string; now?: number }
) {
  const { leaseHash, ...base } = lease;
  if (sha256Hex(base) !== leaseHash) {
    throw new ControlPlaneError("FORBIDDEN", "Durable job lease integrity check failed");
  }
  const now = input.now ?? Date.now();
  if (
    lease.jobId !== input.jobId
    || (input.workerId && lease.workerId !== input.workerId)
    || lease.state !== "active"
    || Date.parse(lease.expiresAt) <= now
  ) {
    throw new ControlPlaneError("CONFLICT", "Durable job lease is stale, inactive, or mismatched");
  }
  return lease;
}

export function renewDurableJobLease(
  lease: DurableJobLease,
  input: { now: string; extendSeconds: number }
): DurableJobLease {
  const now = parse(input.now, "heartbeatAt");
  assertDurableJobLease(lease, { jobId: lease.jobId, workerId: lease.workerId, now });
  if (!Number.isInteger(input.extendSeconds) || input.extendSeconds < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Positive heartbeat extension is required");
  }
  const base = {
    ...lease,
    heartbeatAt: new Date(now).toISOString(),
    expiresAt: new Date(now + input.extendSeconds * 1000).toISOString(),
    version: lease.version + 1
  };
  delete (base as Partial<DurableJobLease>).leaseHash;
  return Object.freeze({ ...base, leaseHash: sha256Hex(base) }) as DurableJobLease;
}

export function createDeadLetterRecord(input: Omit<DeadLetterRecord, "recordHash">) {
  if (!input.reason.trim() || !Number.isInteger(input.finalAttempt) || input.finalAttempt < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Dead letter requires reason and final attempt");
  }
  parse(input.failedAt, "failedAt");
  return Object.freeze({ ...input, recordHash: sha256Hex(input) });
}
