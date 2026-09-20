import { describe, expect, it } from "vitest";
import {
  assertAtomicReservationCommit,
  assertReservationDispatchable,
  cancelReservation,
  createAllocationRecord,
  createCapacityLedger,
  expireReservation,
  releaseReservation,
  renewReservation,
  reserveCapacity,
  type ReservationAuthority
} from "@/lib/resources/reservations";

const authority: ReservationAuthority = {
  source: "control-plane",
  jobAuthorized: true,
  portfolioId: "portfolio-a",
  companyId: "company-a",
  jobId: "job-1",
  placementRequestId: "placement-1",
  placementDecisionId: "decision-1",
  placementDecisionHash: "decision-hash-1",
  selectedTarget: { type: "resource", id: "resource-a" }
};

function ledger() {
  return createCapacityLedger({
    id: "ledger-resource-a",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    target: { type: "resource", id: "resource-a" },
    totalCapacity: { cpu: 8, memoryMb: 16384 },
    committedCapacity: { cpu: 0, memoryMb: 0 },
    reservedCapacity: { cpu: 0, memoryMb: 0 },
    protectedHeadroom: { cpu: 2, memoryMb: 2048 },
    updatedAt: "2026-09-20T20:00:00Z"
  });
}

function reserve(baseLedger = ledger(), overrides: Record<string, unknown> = {}) {
  return reserveCapacity({
    transactionId: "txn-reserve-1",
    reservationId: "reservation-1",
    ledger: baseLedger,
    expectedLedgerRevision: baseLedger.revision,
    authority,
    requestedCapacity: { cpu: 4, memoryMb: 4096 },
    idempotencyKey: "job-1:decision-1",
    issuedAt: "2026-09-20T20:01:00Z",
    expiresAt: "2026-09-20T20:06:00Z",
    ...overrides
  } as Parameters<typeof reserveCapacity>[0]);
}

describe("Phase 33 reservation and capacity ledger", () => {
  it("reserves capacity atomically against a ledger revision and preserves protected headroom", () => {
    const result = reserve();

    expect(result.replayed).toBe(false);
    expect(result.ledger.revision).toBe(2);
    expect(result.ledger.reservedCapacity).toEqual({ cpu: 4, memoryMb: 4096 });
    expect(result.reservation.requestedCapacity).toEqual({ cpu: 4, memoryMb: 4096 });
    expect(result.reservation.grantedCapacity).toEqual({ cpu: 4, memoryMb: 4096 });
    expect(result.reservation.capacityHeld).toBe(true);
    expect(result.commit?.expectedLedgerRevision).toBe(1);
    expect(result.commit?.nextLedgerRevision).toBe(2);
    expect(result.commit?.expectedLedgerHash).toHaveLength(64);
    expect(result.commit?.commitHash).toHaveLength(64);
  });

  it("fails closed when two concurrent callers use the same stale ledger revision", () => {
    const initial = ledger();
    const first = reserve(initial);

    expect(() => reserveCapacity({
      transactionId: "txn-concurrent-2",
      reservationId: "reservation-2",
      ledger: first.ledger,
      expectedLedgerRevision: initial.revision,
      authority: {
        ...authority,
        jobId: "job-2",
        placementRequestId: "placement-2",
        placementDecisionId: "decision-2",
        placementDecisionHash: "decision-hash-2"
      },
      requestedCapacity: { cpu: 4, memoryMb: 4096 },
      idempotencyKey: "job-2:decision-2",
      issuedAt: "2026-09-20T20:01:01Z",
      expiresAt: "2026-09-20T20:06:01Z"
    })).toThrow(/revision changed/i);
  });

  it("cannot over-allocate even after the concurrent caller refreshes the ledger", () => {
    const first = reserve();

    expect(() => reserveCapacity({
      transactionId: "txn-capacity-block",
      reservationId: "reservation-2",
      ledger: first.ledger,
      expectedLedgerRevision: first.ledger.revision,
      authority: {
        ...authority,
        jobId: "job-2",
        placementRequestId: "placement-2",
        placementDecisionId: "decision-2",
        placementDecisionHash: "decision-hash-2"
      },
      requestedCapacity: { cpu: 4, memoryMb: 4096 },
      idempotencyKey: "job-2:decision-2",
      issuedAt: "2026-09-20T20:01:01Z",
      expiresAt: "2026-09-20T20:06:01Z"
    })).toThrow(/Insufficient unprotected capacity/);
  });

  it("makes reservation replay idempotent without consuming capacity twice", () => {
    const first = reserve();
    const replay = reserveCapacity({
      transactionId: "txn-replay",
      reservationId: "reservation-retry-id-does-not-matter",
      ledger: first.ledger,
      expectedLedgerRevision: first.ledger.revision,
      authority,
      requestedCapacity: { cpu: 4, memoryMb: 4096 },
      idempotencyKey: "job-1:decision-1",
      existingReservation: first.reservation,
      issuedAt: "2026-09-20T20:02:00Z",
      expiresAt: "2026-09-20T20:07:00Z"
    });

    expect(replay.replayed).toBe(true);
    expect(replay.ledger.revision).toBe(first.ledger.revision);
    expect(replay.ledger.reservedCapacity).toEqual(first.ledger.reservedCapacity);
    expect(replay.reservation.id).toBe(first.reservation.id);
    expect(replay.commit).toBeUndefined();
  });

  it("rejects idempotency-key reuse with different logical capacity requirements", () => {
    const first = reserve();

    expect(() => reserveCapacity({
      transactionId: "txn-idempotency-conflict",
      reservationId: "reservation-conflict",
      ledger: first.ledger,
      expectedLedgerRevision: first.ledger.revision,
      authority,
      requestedCapacity: { cpu: 2, memoryMb: 2048 },
      idempotencyKey: "job-1:decision-1",
      existingReservation: first.reservation,
      issuedAt: "2026-09-20T20:02:00Z",
      expiresAt: "2026-09-20T20:07:00Z"
    })).toThrow(/different logical requirements/i);
  });

  it("tracks partial requested-versus-granted capacity only with explicit authorization", () => {
    expect(() => reserve(undefined, {
      grantedCapacity: { cpu: 2, memoryMb: 2048 }
    })).toThrow(/Partial capacity grants require explicit/);

    const result = reserve(undefined, {
      transactionId: "txn-partial",
      reservationId: "reservation-partial",
      idempotencyKey: "job-1:decision-1:partial",
      grantedCapacity: { cpu: 2, memoryMb: 2048 },
      partialGrantAuthorized: true
    });

    expect(result.reservation.requestedCapacity).toEqual({ cpu: 4, memoryMb: 4096 });
    expect(result.reservation.grantedCapacity).toEqual({ cpu: 2, memoryMb: 2048 });
    expect(result.reservation.partialGrantAuthorized).toBe(true);
  });

  it("renews an active lease without double-reserving capacity", () => {
    const first = reserve();
    const renewed = renewReservation({
      transactionId: "txn-renew",
      ledger: first.ledger,
      expectedLedgerRevision: first.ledger.revision,
      reservation: first.reservation,
      now: "2026-09-20T20:04:00Z",
      newExpiresAt: "2026-09-20T20:10:00Z"
    });

    expect(renewed.ledger.reservedCapacity).toEqual(first.ledger.reservedCapacity);
    expect(renewed.ledger.revision).toBe(first.ledger.revision + 1);
    expect(renewed.reservation.version).toBe(2);
    expect(renewed.reservation.expiresAt).toBe("2026-09-20T20:10:00.000Z");
  });

  it("expires abandoned reservations safely and restores capacity", () => {
    const first = reserve();
    const expired = expireReservation({
      transactionId: "txn-expire",
      ledger: first.ledger,
      expectedLedgerRevision: first.ledger.revision,
      reservation: first.reservation,
      now: "2026-09-20T20:06:00Z"
    });

    expect(expired.reservation.state).toBe("expired");
    expect(expired.reservation.capacityHeld).toBe(false);
    expect(expired.ledger.reservedCapacity).toEqual({ cpu: 0, memoryMb: 0 });
  });

  it("prevents an expired reservation from being used for dispatch or allocation", () => {
    const first = reserve();
    expect(() => assertReservationDispatchable(
      first.reservation,
      Date.parse("2026-09-20T20:06:00Z")
    )).toThrow(/cannot authorize dispatch/i);

    expect(() => createAllocationRecord({
      id: "allocation-expired",
      reservation: first.reservation,
      jobId: "job-1",
      createdAt: "2026-09-20T20:06:00Z",
      now: Date.parse("2026-09-20T20:06:00Z")
    })).toThrow();
  });

  it("releases capacity exactly once under deterministic replay", () => {
    const first = reserve();
    const released = releaseReservation({
      transactionId: "txn-release",
      ledger: first.ledger,
      expectedLedgerRevision: first.ledger.revision,
      reservation: first.reservation,
      releasedAt: "2026-09-20T20:03:00Z"
    });
    const replay = releaseReservation({
      transactionId: "txn-release-replay",
      ledger: released.ledger,
      expectedLedgerRevision: released.ledger.revision,
      reservation: released.reservation,
      releasedAt: "2026-09-20T20:04:00Z"
    });

    expect(released.ledger.reservedCapacity).toEqual({ cpu: 0, memoryMb: 0 });
    expect(replay.replayed).toBe(true);
    expect(replay.ledger.revision).toBe(released.ledger.revision);
    expect(replay.ledger.reservedCapacity).toEqual({ cpu: 0, memoryMb: 0 });
  });

  it("cancellation releases capacity and cannot conflict with a later release", () => {
    const first = reserve();
    const cancelled = cancelReservation({
      transactionId: "txn-cancel",
      ledger: first.ledger,
      expectedLedgerRevision: first.ledger.revision,
      reservation: first.reservation,
      cancelledAt: "2026-09-20T20:03:00Z"
    });

    expect(cancelled.reservation.state).toBe("cancelled");
    expect(cancelled.ledger.reservedCapacity).toEqual({ cpu: 0, memoryMb: 0 });

    expect(() => releaseReservation({
      transactionId: "txn-release-after-cancel",
      ledger: cancelled.ledger,
      expectedLedgerRevision: cancelled.ledger.revision,
      reservation: cancelled.reservation,
      releasedAt: "2026-09-20T20:04:00Z"
    })).toThrow(/terminal transition conflicts/i);
  });

  it("creates a pending allocation record only from a live reservation and never dispatches", () => {
    const first = reserve();
    const allocation = createAllocationRecord({
      id: "allocation-1",
      reservation: first.reservation,
      jobId: "job-1",
      createdAt: "2026-09-20T20:02:00Z",
      now: Date.parse("2026-09-20T20:02:00Z")
    });

    expect(allocation.status).toBe("pending");
    expect(allocation.capacity).toEqual(first.reservation.grantedCapacity);
    expect(allocation.reservationHash).toBe(first.reservation.reservationHash);
    expect(allocation).not.toHaveProperty("dispatchId");
    expect(allocation).not.toHaveProperty("workerId");
  });

  it("validates atomic commit integrity and rejects tampering", () => {
    const first = reserve();
    expect(first.commit).toBeDefined();
    expect(assertAtomicReservationCommit(first.commit!)).toBe(first.commit);

    expect(() => assertAtomicReservationCommit({
      ...first.commit!,
      nextLedgerRevision: first.commit!.nextLedgerRevision + 1
    })).toThrow();
  });

  it("supports pool ledgers under the same reservation rules", () => {
    const poolLedger = createCapacityLedger({
      id: "ledger-pool-a",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      target: { type: "pool", id: "pool-a" },
      totalCapacity: { jobs: 100 },
      protectedHeadroom: { jobs: 10 },
      updatedAt: "2026-09-20T20:00:00Z"
    });
    const poolAuthority: ReservationAuthority = {
      ...authority,
      selectedTarget: { type: "pool", id: "pool-a" }
    };

    const result = reserveCapacity({
      transactionId: "txn-pool",
      reservationId: "reservation-pool",
      ledger: poolLedger,
      expectedLedgerRevision: poolLedger.revision,
      authority: poolAuthority,
      requestedCapacity: { jobs: 25 },
      idempotencyKey: "job-1:pool-a",
      issuedAt: "2026-09-20T20:01:00Z",
      expiresAt: "2026-09-20T20:06:00Z"
    });

    expect(result.reservation.target).toEqual({ type: "pool", id: "pool-a" });
    expect(result.ledger.reservedCapacity.jobs).toBe(25);
  });

  it("rejects cross-company and wrong-placement-target reservation authority", () => {
    expect(() => reserve(undefined, {
      authority: { ...authority, companyId: "company-b" }
    })).toThrow();

    expect(() => reserve(undefined, {
      authority: {
        ...authority,
        selectedTarget: { type: "resource", id: "resource-b" }
      }
    })).toThrow();
  });
});
