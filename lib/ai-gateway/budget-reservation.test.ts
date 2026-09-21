import { describe, expect, it } from "vitest";
import {
  MemoryAIBudgetReservationStore,
  assertAIBudgetReservationIntegrity,
  assertProductionAIBudgetReservationStoreDescriptor
} from "@/lib/ai-gateway/budget-reservation";

function seed(amount = 100) {
  return [{
    portfolioId: "portfolio",
    companyId: "company",
    period: "2026-09",
    portfolioRemainingCents: amount,
    companyRemainingCents: amount
  }];
}

function reservationInput(overrides: Partial<{
  id: string;
  requestId: string;
  profileId: string;
  idempotencyKey: string;
  reserveCents: number;
}> = {}) {
  return {
    id: overrides.id ?? "reservation-1",
    requestId: overrides.requestId ?? "request-1",
    portfolioId: "portfolio",
    companyId: "company",
    period: "2026-09",
    profileId: overrides.profileId ?? "standard-a",
    idempotencyKey: overrides.idempotencyKey ?? "idem-1",
    reserveCents: overrides.reserveCents ?? 40,
    createdAt: "2026-09-20T22:00:00Z",
    expiresAt: "2026-09-20T22:15:00Z"
  };
}

describe("atomic AI budget reservation contract", () => {
  it("rejects non-durable stores as production budget authority", () => {
    const store = new MemoryAIBudgetReservationStore(seed());
    expect(() => assertProductionAIBudgetReservationStoreDescriptor(store.descriptor))
      .toThrow(/durable atomic CAS persistence/i);
  });

  it("prevents concurrent reservations from overspending the same company and portfolio budget", async () => {
    const store = new MemoryAIBudgetReservationStore(seed(100));

    const results = await Promise.allSettled([
      store.reserveAtomic(reservationInput({
        id: "reservation-a",
        requestId: "request-a",
        idempotencyKey: "idem-a",
        reserveCents: 70
      })),
      store.reserveAtomic(reservationInput({
        id: "reservation-b",
        requestId: "request-b",
        idempotencyKey: "idem-b",
        reserveCents: 70
      }))
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(store.remaining({
      portfolioId: "portfolio",
      companyId: "company",
      period: "2026-09"
    })).toEqual({
      portfolioRemainingCents: 30,
      companyRemainingCents: 30
    });
  });

  it("replays the same idempotent reservation without double-debiting budget", async () => {
    const store = new MemoryAIBudgetReservationStore(seed(100));
    const input = reservationInput({ reserveCents: 40 });

    const first = await store.reserveAtomic(input);
    const second = await store.reserveAtomic(input);

    expect(first.status).toBe("reserved");
    expect(second.status).toBe("idempotent-replay");
    expect(second.reservation.reservationHash).toBe(first.reservation.reservationHash);
    expect(store.remaining({
      portfolioId: "portfolio",
      companyId: "company",
      period: "2026-09"
    }).companyRemainingCents).toBe(60);
  });

  it("rejects idempotency-key reuse for different reservation semantics", async () => {
    const store = new MemoryAIBudgetReservationStore(seed());
    await store.reserveAtomic(reservationInput());

    await expect(store.reserveAtomic(reservationInput({
      id: "reservation-2",
      requestId: "request-2",
      idempotencyKey: "idem-1"
    }))).rejects.toThrow(/idempotency key was reused/i);
  });

  it("commits actual usage and returns unused reserved budget atomically", async () => {
    const store = new MemoryAIBudgetReservationStore(seed(100));
    const initial = await store.reserveAtomic(reservationInput({ reserveCents: 80 }));

    const committed = await store.commit({
      reservationId: initial.reservation.id,
      expectedReservationHash: initial.reservation.reservationHash,
      actualCostCents: 30,
      settledAt: "2026-09-20T22:02:00Z"
    });

    expect(committed.state).toBe("committed");
    expect(committed.actualCostCents).toBe(30);
    expect(store.remaining({
      portfolioId: "portfolio",
      companyId: "company",
      period: "2026-09"
    }).companyRemainingCents).toBe(70);

    await expect(store.reserveAtomic(reservationInput({
      id: "reservation-2",
      requestId: "request-2",
      idempotencyKey: "idem-2",
      reserveCents: 70
    }))).resolves.toMatchObject({ status: "reserved" });
  });

  it("release restores capacity exactly once and integrity hashing detects tampering", async () => {
    const store = new MemoryAIBudgetReservationStore(seed(100));
    const initial = await store.reserveAtomic(reservationInput({ reserveCents: 55 }));

    expect(() => assertAIBudgetReservationIntegrity({
      ...initial.reservation,
      reservedCents: 1
    })).toThrow(/integrity/i);

    const released = await store.release({
      reservationId: initial.reservation.id,
      expectedReservationHash: initial.reservation.reservationHash,
      settledAt: "2026-09-20T22:03:00Z"
    });
    expect(released.state).toBe("released");
    expect(store.remaining({
      portfolioId: "portfolio",
      companyId: "company",
      period: "2026-09"
    }).companyRemainingCents).toBe(100);

    await expect(store.release({
      reservationId: released.id,
      expectedReservationHash: released.reservationHash,
      settledAt: "2026-09-20T22:04:00Z"
    })).rejects.toThrow(/stale, settled, or hash-mismatched/i);
  });
});
