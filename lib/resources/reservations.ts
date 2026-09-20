import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export type CapacityVector = Readonly<Record<string, number>>;
export type CapacityTarget =
  | Readonly<{ type: "resource"; id: string }>
  | Readonly<{ type: "pool"; id: string }>;

export interface CapacityLedger {
  id: string;
  portfolioId: string;
  companyId: string;
  target: CapacityTarget;
  totalCapacity: CapacityVector;
  committedCapacity: CapacityVector;
  reservedCapacity: CapacityVector;
  protectedHeadroom: CapacityVector;
  revision: number;
  updatedAt: string;
  ledgerHash: string;
}

export interface ReservationAuthority {
  source: "control-plane";
  jobAuthorized: true;
  portfolioId: string;
  companyId: string;
  jobId: string;
  placementRequestId: string;
  placementDecisionId: string;
  placementDecisionHash: string;
  selectedTarget: CapacityTarget;
}

export type ReservationState =
  | "active"
  | "released"
  | "cancelled"
  | "expired";

export interface CapacityReservation {
  id: string;
  portfolioId: string;
  companyId: string;
  jobId: string;
  placementRequestId: string;
  placementDecisionId: string;
  placementDecisionHash: string;
  target: CapacityTarget;
  requestedCapacity: CapacityVector;
  grantedCapacity: CapacityVector;
  partialGrantAuthorized: boolean;
  idempotencyKey: string;
  logicalRequestHash: string;
  state: ReservationState;
  capacityHeld: boolean;
  leaseIssuedAt: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  releasedAt?: string;
  cancelledAt?: string;
  expiredAt?: string;
  version: number;
  reservationHash: string;
}

export interface AllocationRecord {
  id: string;
  portfolioId: string;
  companyId: string;
  jobId: string;
  reservationId: string;
  reservationHash: string;
  target: CapacityTarget;
  capacity: CapacityVector;
  status: "pending";
  createdAt: string;
  allocationHash: string;
}

export type ReservationOperation =
  | "reserve"
  | "renew"
  | "release"
  | "cancel"
  | "expire";

export interface AtomicReservationCommit {
  transactionId: string;
  operation: ReservationOperation;
  idempotencyKey: string;
  ledgerId: string;
  expectedLedgerRevision: number;
  expectedLedgerHash: string;
  nextLedgerRevision: number;
  nextLedgerHash: string;
  expectedReservationHash?: string;
  nextReservationHash: string;
  nextLedger: CapacityLedger;
  nextReservation: CapacityReservation;
  commitHash: string;
}

export interface ReservationMutationResult {
  ledger: CapacityLedger;
  reservation: CapacityReservation;
  commit?: AtomicReservationCommit;
  replayed: boolean;
}

/**
 * Production persistence must commit ledger + reservation atomically.
 *
 * Required fail-closed semantics:
 * - compare ledger revision AND ledger hash;
 * - compare the current reservation hash for mutation operations;
 * - enforce unique (portfolioId, companyId, idempotencyKey);
 * - write next ledger + next reservation in one transaction;
 * - return conflict instead of retrying against stale state automatically.
 *
 * This interface intentionally does not provide an in-memory production store.
 */
export interface AtomicReservationStore {
  commit(input: AtomicReservationCommit): Promise<
    | { status: "committed"; commitHash: string }
    | { status: "idempotent-replay"; reservation: CapacityReservation }
    | { status: "conflict"; currentLedgerRevision: number }
  >;
}

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

function normalizeVector(vector: CapacityVector, label: string, requirePositive = false) {
  const entries = Object.entries(vector).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must contain capacity dimensions`);
  }

  let hasPositive = false;
  const normalized: Record<string, number> = {};
  for (const [dimension, value] of entries) {
    if (!dimension.trim() || !Number.isFinite(value) || value < 0) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        `${label} contains an invalid capacity dimension`
      );
    }
    if (value > 0) hasPositive = true;
    normalized[dimension] = value;
  }

  if (requirePositive && !hasPositive) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must request positive capacity`);
  }
  return Object.freeze(normalized) as CapacityVector;
}

function sameTarget(left: CapacityTarget, right: CapacityTarget) {
  return left.type === right.type && left.id === right.id;
}

function vectorValue(vector: CapacityVector, dimension: string) {
  return vector[dimension] ?? 0;
}

function addVectors(left: CapacityVector, right: CapacityVector) {
  const dimensions = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const result: Record<string, number> = {};
  for (const dimension of dimensions) {
    result[dimension] = vectorValue(left, dimension) + vectorValue(right, dimension);
  }
  return Object.freeze(result) as CapacityVector;
}

function subtractVectors(left: CapacityVector, right: CapacityVector, label: string) {
  const dimensions = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const result: Record<string, number> = {};
  for (const dimension of dimensions) {
    const next = vectorValue(left, dimension) - vectorValue(right, dimension);
    if (next < 0) {
      throw new ControlPlaneError(
        "CONFLICT",
        `${label} would make ${dimension} capacity negative`
      );
    }
    result[dimension] = next;
  }
  return Object.freeze(result) as CapacityVector;
}

function assertVectorAtMost(
  lesser: CapacityVector,
  greater: CapacityVector,
  code: "VALIDATION_FAILED" | "POLICY_BLOCKED",
  message: string
) {
  for (const [dimension, value] of Object.entries(lesser)) {
    if (value > vectorValue(greater, dimension)) {
      throw new ControlPlaneError(code, `${message}: ${dimension}`);
    }
  }
}

function assertLedgerIntegrity(ledger: CapacityLedger) {
  const { ledgerHash, ...base } = ledger;
  if (sha256Hex(base) !== ledgerHash) {
    throw new ControlPlaneError("FORBIDDEN", "Capacity ledger integrity check failed");
  }
  if (!Number.isInteger(ledger.revision) || ledger.revision < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Capacity ledger revision must be positive");
  }

  const dimensions = new Set([
    ...Object.keys(ledger.totalCapacity),
    ...Object.keys(ledger.committedCapacity),
    ...Object.keys(ledger.reservedCapacity),
    ...Object.keys(ledger.protectedHeadroom)
  ]);
  for (const dimension of dimensions) {
    const total = vectorValue(ledger.totalCapacity, dimension);
    const committed = vectorValue(ledger.committedCapacity, dimension);
    const reserved = vectorValue(ledger.reservedCapacity, dimension);
    const protectedHeadroom = vectorValue(ledger.protectedHeadroom, dimension);
    if (
      total < 0
      || committed < 0
      || reserved < 0
      || protectedHeadroom < 0
      || committed + reserved + protectedHeadroom > total
    ) {
      throw new ControlPlaneError(
        "CONFLICT",
        `Capacity ledger invariant failed for ${dimension}`
      );
    }
  }
}

function assertReservationIntegrity(reservation: CapacityReservation) {
  const { reservationHash, ...base } = reservation;
  if (sha256Hex(base) !== reservationHash) {
    throw new ControlPlaneError("FORBIDDEN", "Reservation integrity check failed");
  }
  if (!Number.isInteger(reservation.version) || reservation.version < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Reservation version must be positive");
  }
  if (reservation.state === "active" && !reservation.capacityHeld) {
    throw new ControlPlaneError("CONFLICT", "Active reservation must hold capacity");
  }
  if (reservation.state !== "active" && reservation.capacityHeld) {
    throw new ControlPlaneError("CONFLICT", "Terminal reservation cannot hold capacity");
  }
}

function assertLedgerScope(
  ledger: CapacityLedger,
  scope: Pick<TrustedExecutionScope, "portfolioId" | "companyId">
) {
  if (
    ledger.portfolioId !== scope.portfolioId
    || ledger.companyId !== scope.companyId
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Capacity ledger is outside trusted scope");
  }
}

function assertExpectedLedgerRevision(ledger: CapacityLedger, expectedRevision: number) {
  if (ledger.revision !== expectedRevision) {
    throw new ControlPlaneError(
      "CONFLICT",
      "Capacity ledger revision changed; stale mutation must be retried from fresh state",
      {
        details: {
          expectedRevision,
          currentRevision: ledger.revision
        }
      }
    );
  }
}

function assertAuthority(
  authority: ReservationAuthority,
  ledger: CapacityLedger
) {
  if (
    authority.source !== "control-plane"
    || authority.jobAuthorized !== true
    || authority.portfolioId !== ledger.portfolioId
    || authority.companyId !== ledger.companyId
    || !authority.jobId
    || !authority.placementRequestId
    || !authority.placementDecisionId
    || !authority.placementDecisionHash
    || !sameTarget(authority.selectedTarget, ledger.target)
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Reservation requires an authorized placement decision for this ledger target"
    );
  }
}

function createLedgerBase(input: Omit<CapacityLedger, "ledgerHash">): CapacityLedger {
  const base: Omit<CapacityLedger, "ledgerHash"> = {
    id: input.id,
    portfolioId: input.portfolioId,
    companyId: input.companyId,
    target: Object.freeze({ ...input.target }),
    totalCapacity: normalizeVector(input.totalCapacity, "Total capacity"),
    committedCapacity: normalizeVector(input.committedCapacity, "Committed capacity"),
    reservedCapacity: normalizeVector(input.reservedCapacity, "Reserved capacity"),
    protectedHeadroom: normalizeVector(input.protectedHeadroom, "Protected headroom"),
    revision: input.revision,
    updatedAt: input.updatedAt
  };
  const ledger = Object.freeze({ ...base, ledgerHash: sha256Hex(base) });
  assertLedgerIntegrity(ledger);
  return ledger;
}

export function createCapacityLedger(input: {
  id: string;
  portfolioId: string;
  companyId: string;
  target: CapacityTarget;
  totalCapacity: CapacityVector;
  committedCapacity?: CapacityVector;
  reservedCapacity?: CapacityVector;
  protectedHeadroom?: CapacityVector;
  revision?: number;
  updatedAt: string;
}): CapacityLedger {
  if (!input.id || !input.portfolioId || !input.companyId || !input.target.id) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Capacity ledger identity and scope are required");
  }
  parseTime(input.updatedAt, "Capacity ledger updatedAt");
  const dimensions = Object.keys(input.totalCapacity);
  const zeros = Object.freeze(
    Object.fromEntries(dimensions.map((dimension) => [dimension, 0]))
  ) as CapacityVector;

  return createLedgerBase({
    id: input.id,
    portfolioId: input.portfolioId,
    companyId: input.companyId,
    target: input.target,
    totalCapacity: input.totalCapacity,
    committedCapacity: input.committedCapacity ?? zeros,
    reservedCapacity: input.reservedCapacity ?? zeros,
    protectedHeadroom: input.protectedHeadroom ?? zeros,
    revision: input.revision ?? 1,
    updatedAt: new Date(parseTime(input.updatedAt, "Capacity ledger updatedAt")).toISOString()
  });
}

function logicalReservationRequest(input: {
  authority: ReservationAuthority;
  requestedCapacity: CapacityVector;
  grantedCapacity: CapacityVector;
  partialGrantAuthorized: boolean;
  idempotencyKey: string;
}) {
  return {
    portfolioId: input.authority.portfolioId,
    companyId: input.authority.companyId,
    jobId: input.authority.jobId,
    placementRequestId: input.authority.placementRequestId,
    placementDecisionId: input.authority.placementDecisionId,
    placementDecisionHash: input.authority.placementDecisionHash,
    target: input.authority.selectedTarget,
    requestedCapacity: input.requestedCapacity,
    grantedCapacity: input.grantedCapacity,
    partialGrantAuthorized: input.partialGrantAuthorized,
    idempotencyKey: input.idempotencyKey
  };
}

function createReservationBase(
  input: Omit<CapacityReservation, "reservationHash">
): CapacityReservation {
  const base: Omit<CapacityReservation, "reservationHash"> = {
    ...input,
    target: Object.freeze({ ...input.target }),
    requestedCapacity: normalizeVector(input.requestedCapacity, "Requested capacity", true),
    grantedCapacity: normalizeVector(input.grantedCapacity, "Granted capacity", true)
  };
  const reservation = Object.freeze({
    ...base,
    reservationHash: sha256Hex(base)
  });
  assertReservationIntegrity(reservation);
  return reservation;
}

function createCommit(input: {
  transactionId: string;
  operation: ReservationOperation;
  idempotencyKey: string;
  previousLedger: CapacityLedger;
  nextLedger: CapacityLedger;
  previousReservation?: CapacityReservation;
  nextReservation: CapacityReservation;
}): AtomicReservationCommit {
  if (!input.transactionId) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Reservation transaction ID is required");
  }
  const base: Omit<AtomicReservationCommit, "commitHash"> = {
    transactionId: input.transactionId,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
    ledgerId: input.previousLedger.id,
    expectedLedgerRevision: input.previousLedger.revision,
    expectedLedgerHash: input.previousLedger.ledgerHash,
    nextLedgerRevision: input.nextLedger.revision,
    nextLedgerHash: input.nextLedger.ledgerHash,
    expectedReservationHash: input.previousReservation?.reservationHash,
    nextReservationHash: input.nextReservation.reservationHash,
    nextLedger: input.nextLedger,
    nextReservation: input.nextReservation
  };
  return Object.freeze({ ...base, commitHash: sha256Hex(base) });
}

function updateLedgerReservation(
  ledger: CapacityLedger,
  reservedCapacity: CapacityVector,
  updatedAt: string
) {
  return createLedgerBase({
    ...ledger,
    reservedCapacity,
    revision: ledger.revision + 1,
    updatedAt
  });
}

export function reserveCapacity(input: {
  transactionId: string;
  reservationId: string;
  ledger: CapacityLedger;
  expectedLedgerRevision: number;
  authority: ReservationAuthority;
  requestedCapacity: CapacityVector;
  grantedCapacity?: CapacityVector;
  partialGrantAuthorized?: boolean;
  idempotencyKey: string;
  existingReservation?: CapacityReservation;
  issuedAt: string;
  expiresAt: string;
}): ReservationMutationResult {
  assertLedgerIntegrity(input.ledger);
  assertExpectedLedgerRevision(input.ledger, input.expectedLedgerRevision);
  assertLedgerScope(input.ledger, input.authority);
  assertAuthority(input.authority, input.ledger);

  if (!input.reservationId || !input.idempotencyKey) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Reservation ID and idempotency key are required"
    );
  }

  const issuedAtMs = parseTime(input.issuedAt, "Reservation lease issue time");
  const expiresAtMs = parseTime(input.expiresAt, "Reservation lease expiry");
  if (expiresAtMs <= issuedAtMs) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Reservation lease expiry must follow issue time"
    );
  }

  const requestedCapacity = normalizeVector(
    input.requestedCapacity,
    "Requested capacity",
    true
  );
  const grantedCapacity = normalizeVector(
    input.grantedCapacity ?? requestedCapacity,
    "Granted capacity",
    true
  );
  assertVectorAtMost(
    grantedCapacity,
    requestedCapacity,
    "VALIDATION_FAILED",
    "Granted capacity exceeds requested capacity"
  );

  const partialGrantAuthorized = input.partialGrantAuthorized ?? false;
  const partial = Object.keys(requestedCapacity).some(
    (dimension) => vectorValue(grantedCapacity, dimension) !== requestedCapacity[dimension]
  );
  if (partial && !partialGrantAuthorized) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Partial capacity grants require explicit control-plane authorization"
    );
  }

  const logicalRequestHash = sha256Hex(logicalReservationRequest({
    authority: input.authority,
    requestedCapacity,
    grantedCapacity,
    partialGrantAuthorized,
    idempotencyKey: input.idempotencyKey
  }));

  if (input.existingReservation) {
    assertReservationIntegrity(input.existingReservation);
    if (
      input.existingReservation.portfolioId !== input.authority.portfolioId
      || input.existingReservation.companyId !== input.authority.companyId
      || input.existingReservation.idempotencyKey !== input.idempotencyKey
    ) {
      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "Reservation idempotency key resolves outside the requested scope"
      );
    }
    if (input.existingReservation.logicalRequestHash !== logicalRequestHash) {
      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "Reservation idempotency key was reused with different logical requirements"
      );
    }
    return Object.freeze({
      ledger: input.ledger,
      reservation: input.existingReservation,
      replayed: true
    });
  }

  const freeBefore: Record<string, number> = {};
  const dimensions = new Set([
    ...Object.keys(input.ledger.totalCapacity),
    ...Object.keys(grantedCapacity)
  ]);
  for (const dimension of dimensions) {
    freeBefore[dimension] = (
      vectorValue(input.ledger.totalCapacity, dimension)
      - vectorValue(input.ledger.committedCapacity, dimension)
      - vectorValue(input.ledger.reservedCapacity, dimension)
      - vectorValue(input.ledger.protectedHeadroom, dimension)
    );
  }
  assertVectorAtMost(
    grantedCapacity,
    Object.freeze(freeBefore),
    "POLICY_BLOCKED",
    "Insufficient unprotected capacity"
  );

  const nextReserved = addVectors(input.ledger.reservedCapacity, grantedCapacity);
  const normalizedIssuedAt = new Date(issuedAtMs).toISOString();
  const normalizedExpiresAt = new Date(expiresAtMs).toISOString();
  const nextLedger = updateLedgerReservation(
    input.ledger,
    nextReserved,
    normalizedIssuedAt
  );

  const reservation = createReservationBase({
    id: input.reservationId,
    portfolioId: input.authority.portfolioId,
    companyId: input.authority.companyId,
    jobId: input.authority.jobId,
    placementRequestId: input.authority.placementRequestId,
    placementDecisionId: input.authority.placementDecisionId,
    placementDecisionHash: input.authority.placementDecisionHash,
    target: input.authority.selectedTarget,
    requestedCapacity,
    grantedCapacity,
    partialGrantAuthorized,
    idempotencyKey: input.idempotencyKey,
    logicalRequestHash,
    state: "active",
    capacityHeld: true,
    leaseIssuedAt: normalizedIssuedAt,
    expiresAt: normalizedExpiresAt,
    createdAt: normalizedIssuedAt,
    updatedAt: normalizedIssuedAt,
    version: 1
  });

  return Object.freeze({
    ledger: nextLedger,
    reservation,
    commit: createCommit({
      transactionId: input.transactionId,
      operation: "reserve",
      idempotencyKey: input.idempotencyKey,
      previousLedger: input.ledger,
      nextLedger,
      nextReservation: reservation
    }),
    replayed: false
  });
}

function assertReservationMutationScope(
  ledger: CapacityLedger,
  reservation: CapacityReservation
) {
  assertLedgerIntegrity(ledger);
  assertReservationIntegrity(reservation);
  if (
    ledger.portfolioId !== reservation.portfolioId
    || ledger.companyId !== reservation.companyId
    || !sameTarget(ledger.target, reservation.target)
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Reservation and capacity ledger scope/target do not match"
    );
  }
}

export function renewReservation(input: {
  transactionId: string;
  ledger: CapacityLedger;
  expectedLedgerRevision: number;
  reservation: CapacityReservation;
  now: string;
  newExpiresAt: string;
}): ReservationMutationResult {
  assertReservationMutationScope(input.ledger, input.reservation);
  assertExpectedLedgerRevision(input.ledger, input.expectedLedgerRevision);
  const nowMs = parseTime(input.now, "Reservation renewal time");
  const currentExpiry = parseTime(input.reservation.expiresAt, "Reservation expiry");
  const newExpiry = parseTime(input.newExpiresAt, "Renewed reservation expiry");

  if (
    input.reservation.state !== "active"
    || !input.reservation.capacityHeld
    || nowMs >= currentExpiry
  ) {
    throw new ControlPlaneError("CONFLICT", "Expired or inactive reservation cannot be renewed");
  }
  if (newExpiry <= currentExpiry || newExpiry <= nowMs) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Renewed reservation expiry must extend the active lease"
    );
  }

  const normalizedNow = new Date(nowMs).toISOString();
  const nextLedger = updateLedgerReservation(
    input.ledger,
    input.ledger.reservedCapacity,
    normalizedNow
  );
  const current: Omit<CapacityReservation, "reservationHash"> = {
    id: input.reservation.id,
    portfolioId: input.reservation.portfolioId,
    companyId: input.reservation.companyId,
    jobId: input.reservation.jobId,
    placementRequestId: input.reservation.placementRequestId,
    placementDecisionId: input.reservation.placementDecisionId,
    placementDecisionHash: input.reservation.placementDecisionHash,
    target: input.reservation.target,
    requestedCapacity: input.reservation.requestedCapacity,
    grantedCapacity: input.reservation.grantedCapacity,
    partialGrantAuthorized: input.reservation.partialGrantAuthorized,
    idempotencyKey: input.reservation.idempotencyKey,
    logicalRequestHash: input.reservation.logicalRequestHash,
    state: input.reservation.state,
    capacityHeld: input.reservation.capacityHeld,
    leaseIssuedAt: input.reservation.leaseIssuedAt,
    expiresAt: input.reservation.expiresAt,
    createdAt: input.reservation.createdAt,
    updatedAt: input.reservation.updatedAt,
    releasedAt: input.reservation.releasedAt,
    cancelledAt: input.reservation.cancelledAt,
    expiredAt: input.reservation.expiredAt,
    version: input.reservation.version
  };
  const nextReservation = createReservationBase({
    ...current,
    expiresAt: new Date(newExpiry).toISOString(),
    updatedAt: normalizedNow,
    version: input.reservation.version + 1
  });

  return Object.freeze({
    ledger: nextLedger,
    reservation: nextReservation,
    commit: createCommit({
      transactionId: input.transactionId,
      operation: "renew",
      idempotencyKey: input.reservation.idempotencyKey,
      previousLedger: input.ledger,
      nextLedger,
      previousReservation: input.reservation,
      nextReservation
    }),
    replayed: false
  });
}

function terminateReservation(input: {
  transactionId: string;
  operation: "release" | "cancel" | "expire";
  ledger: CapacityLedger;
  expectedLedgerRevision: number;
  reservation: CapacityReservation;
  at: string;
}): ReservationMutationResult {
  assertReservationMutationScope(input.ledger, input.reservation);
  assertExpectedLedgerRevision(input.ledger, input.expectedLedgerRevision);

  if (input.reservation.state !== "active") {
    if (
      (input.operation === "release" && input.reservation.state === "released")
      || (input.operation === "cancel" && input.reservation.state === "cancelled")
      || (input.operation === "expire" && input.reservation.state === "expired")
    ) {
      return Object.freeze({
        ledger: input.ledger,
        reservation: input.reservation,
        replayed: true
      });
    }
    throw new ControlPlaneError(
      "CONFLICT",
      "Reservation terminal transition conflicts with its current state"
    );
  }

  const atMs = parseTime(input.at, "Reservation transition time");
  if (
    input.operation === "expire"
    && atMs < parseTime(input.reservation.expiresAt, "Reservation expiry")
  ) {
    throw new ControlPlaneError("CONFLICT", "Active reservation cannot expire before lease expiry");
  }

  const normalizedAt = new Date(atMs).toISOString();
  const nextReserved = subtractVectors(
    input.ledger.reservedCapacity,
    input.reservation.grantedCapacity,
    "Reservation release"
  );
  const nextLedger = updateLedgerReservation(
    input.ledger,
    nextReserved,
    normalizedAt
  );

  const current: Omit<CapacityReservation, "reservationHash"> = {
    id: input.reservation.id,
    portfolioId: input.reservation.portfolioId,
    companyId: input.reservation.companyId,
    jobId: input.reservation.jobId,
    placementRequestId: input.reservation.placementRequestId,
    placementDecisionId: input.reservation.placementDecisionId,
    placementDecisionHash: input.reservation.placementDecisionHash,
    target: input.reservation.target,
    requestedCapacity: input.reservation.requestedCapacity,
    grantedCapacity: input.reservation.grantedCapacity,
    partialGrantAuthorized: input.reservation.partialGrantAuthorized,
    idempotencyKey: input.reservation.idempotencyKey,
    logicalRequestHash: input.reservation.logicalRequestHash,
    state: input.reservation.state,
    capacityHeld: input.reservation.capacityHeld,
    leaseIssuedAt: input.reservation.leaseIssuedAt,
    expiresAt: input.reservation.expiresAt,
    createdAt: input.reservation.createdAt,
    updatedAt: input.reservation.updatedAt,
    releasedAt: input.reservation.releasedAt,
    cancelledAt: input.reservation.cancelledAt,
    expiredAt: input.reservation.expiredAt,
    version: input.reservation.version
  };
  const nextReservation = createReservationBase({
    ...current,
    state: input.operation === "release"
      ? "released"
      : input.operation === "cancel"
        ? "cancelled"
        : "expired",
    capacityHeld: false,
    updatedAt: normalizedAt,
    releasedAt: input.operation === "release" ? normalizedAt : undefined,
    cancelledAt: input.operation === "cancel" ? normalizedAt : undefined,
    expiredAt: input.operation === "expire" ? normalizedAt : undefined,
    version: input.reservation.version + 1
  });

  return Object.freeze({
    ledger: nextLedger,
    reservation: nextReservation,
    commit: createCommit({
      transactionId: input.transactionId,
      operation: input.operation,
      idempotencyKey: input.reservation.idempotencyKey,
      previousLedger: input.ledger,
      nextLedger,
      previousReservation: input.reservation,
      nextReservation
    }),
    replayed: false
  });
}

export function releaseReservation(input: {
  transactionId: string;
  ledger: CapacityLedger;
  expectedLedgerRevision: number;
  reservation: CapacityReservation;
  releasedAt: string;
}) {
  return terminateReservation({
    transactionId: input.transactionId,
    operation: "release",
    ledger: input.ledger,
    expectedLedgerRevision: input.expectedLedgerRevision,
    reservation: input.reservation,
    at: input.releasedAt
  });
}

export function cancelReservation(input: {
  transactionId: string;
  ledger: CapacityLedger;
  expectedLedgerRevision: number;
  reservation: CapacityReservation;
  cancelledAt: string;
}) {
  return terminateReservation({
    transactionId: input.transactionId,
    operation: "cancel",
    ledger: input.ledger,
    expectedLedgerRevision: input.expectedLedgerRevision,
    reservation: input.reservation,
    at: input.cancelledAt
  });
}

export function expireReservation(input: {
  transactionId: string;
  ledger: CapacityLedger;
  expectedLedgerRevision: number;
  reservation: CapacityReservation;
  now: string;
}) {
  return terminateReservation({
    transactionId: input.transactionId,
    operation: "expire",
    ledger: input.ledger,
    expectedLedgerRevision: input.expectedLedgerRevision,
    reservation: input.reservation,
    at: input.now
  });
}

export function assertReservationDispatchable(
  reservation: CapacityReservation,
  now = Date.now()
) {
  assertReservationIntegrity(reservation);
  if (
    reservation.state !== "active"
    || !reservation.capacityHeld
    || Date.parse(reservation.leaseIssuedAt) > now
    || Date.parse(reservation.expiresAt) <= now
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Reservation is inactive or expired and cannot authorize dispatch"
    );
  }
  return reservation;
}

export function createAllocationRecord(input: {
  id: string;
  reservation: CapacityReservation;
  jobId: string;
  createdAt: string;
  now?: number;
}): AllocationRecord {
  if (!input.id || input.jobId !== input.reservation.jobId) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Allocation must belong to the reservation's authorized job"
    );
  }
  assertReservationDispatchable(input.reservation, input.now);
  const createdAt = new Date(parseTime(input.createdAt, "Allocation createdAt")).toISOString();
  const base: Omit<AllocationRecord, "allocationHash"> = {
    id: input.id,
    portfolioId: input.reservation.portfolioId,
    companyId: input.reservation.companyId,
    jobId: input.reservation.jobId,
    reservationId: input.reservation.id,
    reservationHash: input.reservation.reservationHash,
    target: input.reservation.target,
    capacity: input.reservation.grantedCapacity,
    status: "pending",
    createdAt
  };
  return Object.freeze({ ...base, allocationHash: sha256Hex(base) });
}


export function assertAtomicReservationCommit(commit: AtomicReservationCommit) {
  const { commitHash, ...base } = commit;
  if (sha256Hex(base) !== commitHash) {
    throw new ControlPlaneError("FORBIDDEN", "Reservation commit integrity check failed");
  }
  if (
    commit.nextLedger.id !== commit.ledgerId
    || commit.nextLedger.revision !== commit.nextLedgerRevision
    || commit.nextLedger.ledgerHash !== commit.nextLedgerHash
    || commit.nextReservation.reservationHash !== commit.nextReservationHash
    || commit.nextLedgerRevision !== commit.expectedLedgerRevision + 1
  ) {
    throw new ControlPlaneError(
      "CONFLICT",
      "Reservation commit lineage or revision invariant failed"
    );
  }
  if (
    commit.operation !== "reserve"
    && !commit.expectedReservationHash
  ) {
    throw new ControlPlaneError(
      "CONFLICT",
      "Reservation mutation commit must compare the current reservation hash"
    );
  }
  return commit;
}
