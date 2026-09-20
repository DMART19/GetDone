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

