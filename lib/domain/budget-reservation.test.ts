import { describe, expect, it } from "vitest";
import {
  assertBudgetReservation,
  createBudgetReservation,
  type BudgetReservation
} from "@/lib/domain/budget-reservation";

const scope = {
  userId: "user-1",
  portfolioId: "portfolio-1",
  companyId: "company-1",
  environment: "staging" as const
};
const now = Date.parse("2026-09-20T22:00:00Z");

function reservation(overrides: Partial<Omit<BudgetReservation, "reservationHash">> = {}) {
  return createBudgetReservation({
    id: "budget-1",
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    policyId: "policy-1",
    policyVersion: "1.0.0",
    planHash: "plan-hash",
    stepHash: "step-hash",
    amountCents: 100,
    currency: "USD",
    reservedAt: "2026-09-20T21:59:00Z",
    expiresAt: "2026-09-20T22:10:00Z",
    ...overrides
  });
}

describe("general budget reservation authority", () => {
  it("creates a hash-bound reservation with reserved status by default", () => {
    const value = reservation();
    expect(value.status).toBe("reserved");
    expect(value.reservationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(assertBudgetReservation({
      reservation: value,
      scope,
      planHash: "plan-hash",
      stepHash: "step-hash",
      minimumAmountCents: 100,
      now
    })).toBe(value);
  });

  it("rejects malformed amounts and invalid reservation windows", () => {
    expect(() => reservation({ amountCents: -1 })).toThrow(/non-negative integer cents/i);
    expect(() => reservation({ amountCents: 1.5 })).toThrow(/non-negative integer cents/i);
    expect(() => reservation({ reservedAt: "not-a-time" })).toThrow(/expiry must follow/i);
    expect(() => reservation({ expiresAt: "not-a-time" })).toThrow(/expiry must follow/i);
    expect(() => reservation({
      reservedAt: "2026-09-20T22:00:00Z",
      expiresAt: "2026-09-20T22:00:00Z"
    })).toThrow(/expiry must follow/i);
  });

  it("rejects tampered reservation integrity before policy evaluation", () => {
    const value = reservation();
    expect(() => assertBudgetReservation({
      reservation: { ...value, amountCents: 999 },
      scope,
      planHash: "plan-hash",
      stepHash: "step-hash",
      minimumAmountCents: 1,
      now
    })).toThrow(/integrity/i);
  });

  it.each([
    ["non-reserved state", () => reservation({ status: "consumed" })],
    ["portfolio mismatch", () => reservation({ portfolioId: "other-portfolio" })],
    ["company mismatch", () => reservation({ companyId: "other-company" })],
    ["plan mismatch", () => reservation({ planHash: "other-plan" })],
    ["step mismatch", () => reservation({ stepHash: "other-step" })],
    ["insufficient amount", () => reservation({ amountCents: 99 })],
    ["future reservation", () => reservation({ reservedAt: "2026-09-20T22:01:00Z" })],
    ["expired reservation", () => reservation({ expiresAt: "2026-09-20T22:00:00Z" })]
  ])("fails closed for %s", (_label, makeReservation) => {
    expect(() => assertBudgetReservation({
      reservation: makeReservation(),
      scope,
      planHash: "plan-hash",
      stepHash: "step-hash",
      minimumAmountCents: 100,
      now
    })).toThrow(/not valid for this work/i);
  });
});
