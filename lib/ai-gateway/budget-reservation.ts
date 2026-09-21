import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";

export const AI_BUDGET_RESERVATION_CONTRACT_VERSION = "1.0.0";

export type AIBudgetReservationState = "reserved" | "committed" | "released";

export interface AIBudgetReservation {
  id: string;
  requestId: string;
  portfolioId: string;
  companyId: string;
  period: string;
  profileId: string;
  idempotencyKey: string;
  reservedCents: number;
  actualCostCents?: number;
  createdAt: string;
  expiresAt: string;
  settledAt?: string;
  state: AIBudgetReservationState;
  version: number;
  reservationHash: string;
}

export interface AIBudgetReservationStoreDescriptor {
  persistence: "durable-external" | "ephemeral-reference";
  atomicReservations: boolean;
  compareAndSwap: boolean;
  restartSafe: boolean;
  multiProcessSafe: boolean;
  productionEligible: boolean;
}

export interface AIBudgetReservationInput {
  id: string;
  requestId: string;
  portfolioId: string;
  companyId: string;
  period: string;
  profileId: string;
  idempotencyKey: string;
  reserveCents: number;
  createdAt: string;
  expiresAt: string;
}

export interface AIBudgetReservationStore {
  readonly descriptor: AIBudgetReservationStoreDescriptor;
  reserveAtomic(input: AIBudgetReservationInput): Promise<{
    status: "reserved" | "idempotent-replay";
    reservation: AIBudgetReservation;
  }>;
  commit(input: {
    reservationId: string;
    expectedReservationHash: string;
    actualCostCents: number;
    settledAt: string;
  }): Promise<AIBudgetReservation>;
  release(input: {
    reservationId: string;
    expectedReservationHash: string;
    settledAt: string;
  }): Promise<AIBudgetReservation>;
  get(reservationId: string): Promise<AIBudgetReservation | null>;
}

export interface AIBudgetLedgerSeed {
  portfolioId: string;
  companyId: string;
  period: string;
  portfolioRemainingCents: number;
  companyRemainingCents: number;
}

function requireNonEmpty(value: string, label: string) {
  if (!value.trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} is required`);
  }
}

function normalizeCents(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a non-negative finite number`);
  }
  return Number(value.toFixed(6));
}

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a timestamp`);
  }
  return parsed;
}

function reservationBase(
  input: Omit<AIBudgetReservation, "reservationHash">
): Omit<AIBudgetReservation, "reservationHash"> {
  return input;
}

function withoutReservationHash(
  reservation: AIBudgetReservation
): Omit<AIBudgetReservation, "reservationHash"> {
  const copy: Partial<AIBudgetReservation> = { ...reservation };
  delete copy.reservationHash;
  return copy as Omit<AIBudgetReservation, "reservationHash">;
}

export function createAIBudgetReservation(
  input: AIBudgetReservationInput
): AIBudgetReservation {
  for (const [value, label] of [
    [input.id, "reservation id"],
    [input.requestId, "request id"],
    [input.portfolioId, "portfolio id"],
    [input.companyId, "company id"],
    [input.period, "period"],
    [input.profileId, "profile id"],
    [input.idempotencyKey, "idempotency key"]
  ] as const) {
    requireNonEmpty(value, label);
  }

  const createdAt = parseTime(input.createdAt, "createdAt");
  const expiresAt = parseTime(input.expiresAt, "expiresAt");
  if (expiresAt <= createdAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Budget reservation expiry must follow creation");
  }

  const base = reservationBase({
    id: input.id,
    requestId: input.requestId,
    portfolioId: input.portfolioId,
    companyId: input.companyId,
    period: input.period,
    profileId: input.profileId,
    idempotencyKey: input.idempotencyKey,
    reservedCents: normalizeCents(input.reserveCents, "reserveCents"),
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    state: "reserved",
    version: 1
  });
  return Object.freeze({ ...base, reservationHash: sha256Hex(base) });
}

export function assertAIBudgetReservationIntegrity(reservation: AIBudgetReservation) {
  const { reservationHash, ...base } = reservation;
  if (sha256Hex(base) !== reservationHash) {
    throw new ControlPlaneError("FORBIDDEN", "AI budget reservation integrity check failed");
  }
  parseTime(reservation.createdAt, "createdAt");
  parseTime(reservation.expiresAt, "expiresAt");
  if (reservation.settledAt) parseTime(reservation.settledAt, "settledAt");
  normalizeCents(reservation.reservedCents, "reservedCents");
  if (reservation.actualCostCents !== undefined) {
    normalizeCents(reservation.actualCostCents, "actualCostCents");
  }
  return reservation;
}

export function assertProductionAIBudgetReservationStoreDescriptor(
  descriptor: AIBudgetReservationStoreDescriptor
) {
  if (
    descriptor.persistence !== "durable-external"
    || !descriptor.atomicReservations
    || !descriptor.compareAndSwap
    || !descriptor.restartSafe
    || !descriptor.multiProcessSafe
    || !descriptor.productionEligible
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Production AI budget reservations require durable atomic CAS persistence and multi-process safety"
    );
  }
  return descriptor;
}

function portfolioKey(portfolioId: string, period: string) {
  return `${portfolioId}:${period}`;
}

function companyKey(portfolioId: string, companyId: string, period: string) {
  return `${portfolioId}:${companyId}:${period}`;
}

function idempotencyKey(input: {
  portfolioId: string;
  companyId: string;
  period: string;
  idempotencyKey: string;
}) {
  return `${input.portfolioId}:${input.companyId}:${input.period}:${input.idempotencyKey}`;
}

/**
 * Deterministic reference store for tests only.
 *
 * It is atomic only inside one JavaScript process and is deliberately marked
 * non-production. Production must provide an external durable implementation.
 */
export class MemoryAIBudgetReservationStore implements AIBudgetReservationStore {
  readonly descriptor = Object.freeze({
    persistence: "ephemeral-reference" as const,
    atomicReservations: true,
    compareAndSwap: true,
    restartSafe: false,
    multiProcessSafe: false,
    productionEligible: false
  });

  private readonly reservations = new Map<string, AIBudgetReservation>();
  private readonly idempotency = new Map<string, string>();
  private readonly portfolioRemaining = new Map<string, number>();
  private readonly companyRemaining = new Map<string, number>();

  constructor(seeds: readonly AIBudgetLedgerSeed[]) {
    for (const seed of seeds) {
      const portfolioRemaining = normalizeCents(seed.portfolioRemainingCents, "portfolioRemainingCents");
      const companyRemaining = normalizeCents(seed.companyRemainingCents, "companyRemainingCents");
      const pKey = portfolioKey(seed.portfolioId, seed.period);
      const existingPortfolio = this.portfolioRemaining.get(pKey);
      if (existingPortfolio !== undefined && existingPortfolio !== portfolioRemaining) {
        throw new ControlPlaneError("CONFLICT", "Portfolio budget seed disagrees for the same period");
      }
      this.portfolioRemaining.set(pKey, portfolioRemaining);
      this.companyRemaining.set(
        companyKey(seed.portfolioId, seed.companyId, seed.period),
        companyRemaining
      );
    }
  }

  async reserveAtomic(input: AIBudgetReservationInput) {
    const requested = createAIBudgetReservation(input);
    const idemKey = idempotencyKey(input);
    const existingId = this.idempotency.get(idemKey);

    if (existingId) {
      const existing = this.reservations.get(existingId)!;
      if (
        existing.requestId !== requested.requestId
        || existing.profileId !== requested.profileId
        || existing.reservedCents !== requested.reservedCents
        || existing.portfolioId !== requested.portfolioId
        || existing.companyId !== requested.companyId
      ) {
        throw new ControlPlaneError(
          "IDEMPOTENCY_CONFLICT",
          "AI budget idempotency key was reused for a different reservation"
        );
      }
      return { status: "idempotent-replay" as const, reservation: existing };
    }

    if (this.reservations.has(requested.id)) {
      throw new ControlPlaneError("CONFLICT", "AI budget reservation id already exists");
    }

    const pKey = portfolioKey(input.portfolioId, input.period);
    const cKey = companyKey(input.portfolioId, input.companyId, input.period);
    const portfolioRemaining = this.portfolioRemaining.get(pKey);
    const companyRemaining = this.companyRemaining.get(cKey);
    if (portfolioRemaining === undefined || companyRemaining === undefined) {
      throw new ControlPlaneError("UNAVAILABLE", "AI budget ledger is not initialized for this scope");
    }

    if (requested.reservedCents > portfolioRemaining || requested.reservedCents > companyRemaining) {
      throw new ControlPlaneError("POLICY_BLOCKED", "Atomic AI budget reservation exceeds remaining budget", {
        details: {
          reason: "AI_BUDGET_RESERVATION_BLOCKED",
          requestedCents: requested.reservedCents
        }
      });
    }

    this.portfolioRemaining.set(pKey, normalizeCents(portfolioRemaining - requested.reservedCents, "portfolioRemainingCents"));
    this.companyRemaining.set(cKey, normalizeCents(companyRemaining - requested.reservedCents, "companyRemainingCents"));
    this.reservations.set(requested.id, requested);
    this.idempotency.set(idemKey, requested.id);
    return { status: "reserved" as const, reservation: requested };
  }

  async commit(input: {
    reservationId: string;
    expectedReservationHash: string;
    actualCostCents: number;
    settledAt: string;
  }) {
    const current = await this.requireReserved(input.reservationId, input.expectedReservationHash);
    const actualCostCents = normalizeCents(input.actualCostCents, "actualCostCents");
    if (actualCostCents > current.reservedCents) {
      throw new ControlPlaneError("POLICY_BLOCKED", "Actual AI cost exceeds the atomic reservation ceiling");
    }

    const settledAt = parseTime(input.settledAt, "settledAt");
    const unused = normalizeCents(current.reservedCents - actualCostCents, "unused reserved cents");
    this.credit(current, unused);

    const base = reservationBase({
      ...withoutReservationHash(current),
      actualCostCents,
      settledAt: new Date(settledAt).toISOString(),
      state: "committed",
      version: current.version + 1
    });
    const next = Object.freeze({ ...base, reservationHash: sha256Hex(base) });
    this.reservations.set(next.id, next);
    return next;
  }

  async release(input: {
    reservationId: string;
    expectedReservationHash: string;
    settledAt: string;
  }) {
    const current = await this.requireReserved(input.reservationId, input.expectedReservationHash);
    const settledAt = parseTime(input.settledAt, "settledAt");
    this.credit(current, current.reservedCents);

    const base = reservationBase({
      ...withoutReservationHash(current),
      settledAt: new Date(settledAt).toISOString(),
      state: "released",
      version: current.version + 1
    });
    const next = Object.freeze({ ...base, reservationHash: sha256Hex(base) });
    this.reservations.set(next.id, next);
    return next;
  }

  async get(reservationId: string) {
    return this.reservations.get(reservationId) ?? null;
  }

  remaining(input: { portfolioId: string; companyId: string; period: string }) {
    return {
      portfolioRemainingCents: this.portfolioRemaining.get(portfolioKey(input.portfolioId, input.period)),
      companyRemainingCents: this.companyRemaining.get(companyKey(input.portfolioId, input.companyId, input.period))
    };
  }

  private async requireReserved(reservationId: string, expectedHash: string) {
    const current = this.reservations.get(reservationId);
    if (!current) {
      throw new ControlPlaneError("NOT_FOUND", "AI budget reservation was not found");
    }
    assertAIBudgetReservationIntegrity(current);
    if (current.reservationHash !== expectedHash || current.state !== "reserved") {
      throw new ControlPlaneError("CONFLICT", "AI budget reservation is stale, settled, or hash-mismatched");
    }
    return current;
  }

  private credit(reservation: AIBudgetReservation, cents: number) {
    const pKey = portfolioKey(reservation.portfolioId, reservation.period);
    const cKey = companyKey(reservation.portfolioId, reservation.companyId, reservation.period);
    this.portfolioRemaining.set(
      pKey,
      normalizeCents((this.portfolioRemaining.get(pKey) ?? 0) + cents, "portfolioRemainingCents")
    );
    this.companyRemaining.set(
      cKey,
      normalizeCents((this.companyRemaining.get(cKey) ?? 0) + cents, "companyRemainingCents")
    );
  }
}
