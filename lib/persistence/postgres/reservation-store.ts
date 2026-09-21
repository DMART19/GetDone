import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  AtomicReservationCommit,
  AtomicReservationStore,
  CapacityReservation
} from "@/lib/resources/reservations";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

export class PostgresAtomicReservationStore implements AtomicReservationStore {
  constructor(private readonly database: PostgresTransactionalDatabase) {}

  async commit(input: AtomicReservationCommit) {
    return this.database.transaction(async (db) => {
    const replay = await db.query<{ commit_hash: string; reservation_id: string }>(
      `SELECT commit_hash,reservation_id FROM reservation_commits
       WHERE portfolio_id=$1 AND company_id=$2 AND idempotency_key=$3
       FOR UPDATE`,
      [
        input.nextReservation.portfolioId,
        input.nextReservation.companyId,
        input.idempotencyKey
      ]
    );
    if (replay.rows[0]) {
      if (replay.rows[0].commit_hash !== input.commitHash) {
        throw new ControlPlaneError(
          "IDEMPOTENCY_CONFLICT",
          "Reservation idempotency key resolves to a different atomic commit"
        );
      }
      const existing = await db.query<{ payload: CapacityReservation }>(
        "SELECT payload FROM capacity_reservations WHERE id=$1",
        [replay.rows[0].reservation_id]
      );
      if (!existing.rows[0]) {
        throw new ControlPlaneError("UNAVAILABLE", "Reservation replay lost its persisted record");
      }
      return { status: "idempotent-replay" as const, reservation: existing.rows[0].payload };
    }

    const ledger = await db.query<{ revision: number; ledger_hash: string }>(
      "SELECT revision,ledger_hash FROM capacity_ledgers WHERE id=$1 FOR UPDATE",
      [input.ledgerId]
    );
    const current = ledger.rows[0];
    if (
      !current
      || current.revision !== input.expectedLedgerRevision
      || current.ledger_hash !== input.expectedLedgerHash
    ) {
      return {
        status: "conflict" as const,
        currentLedgerRevision: current?.revision ?? 0
      };
    }

    if (input.expectedReservationHash) {
      const reservation = await db.query<{ reservation_hash: string }>(
        "SELECT reservation_hash FROM capacity_reservations WHERE id=$1 FOR UPDATE",
        [input.nextReservation.id]
      );
      if (reservation.rows[0]?.reservation_hash !== input.expectedReservationHash) {
        return {
          status: "conflict" as const,
          currentLedgerRevision: current.revision
        };
      }
    }

    const ledgerUpdate = await db.query(
      `UPDATE capacity_ledgers
       SET revision=$2, ledger_hash=$3, payload=$4::jsonb
       WHERE id=$1 AND revision=$5 AND ledger_hash=$6`,
      [
        input.ledgerId,
        input.nextLedgerRevision,
        input.nextLedgerHash,
        JSON.stringify(input.nextLedger),
        input.expectedLedgerRevision,
        input.expectedLedgerHash
      ]
    );
    if (ledgerUpdate.rowCount !== 1) {
      return { status: "conflict" as const, currentLedgerRevision: current.revision };
    }

    await db.query(
      `INSERT INTO capacity_reservations
        (id,portfolio_id,company_id,idempotency_key,reservation_hash,payload)
       VALUES($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         reservation_hash=EXCLUDED.reservation_hash,
         payload=EXCLUDED.payload
       WHERE capacity_reservations.reservation_hash=$7 OR $7 IS NULL`,
      [
        input.nextReservation.id,
        input.nextReservation.portfolioId,
        input.nextReservation.companyId,
        input.nextReservation.idempotencyKey,
        input.nextReservationHash,
        JSON.stringify(input.nextReservation),
        input.expectedReservationHash ?? null
      ]
    );

    await db.query(
      `INSERT INTO reservation_commits
        (transaction_id,portfolio_id,company_id,idempotency_key,commit_hash,reservation_id)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        input.transactionId,
        input.nextReservation.portfolioId,
        input.nextReservation.companyId,
        input.idempotencyKey,
        input.commitHash,
        input.nextReservation.id
      ]
    );

    return { status: "committed" as const, commitHash: input.commitHash };
    });
  }

  async insertLedger(input: AtomicReservationCommit["nextLedger"]): Promise<void> {
    await this.database.query(
      `INSERT INTO capacity_ledgers
        (id,portfolio_id,company_id,revision,ledger_hash,payload)
       VALUES($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        input.id,
        input.portfolioId,
        input.companyId,
        input.revision,
        input.ledgerHash,
        JSON.stringify(input)
      ]
    );
  }
}
