import type { AuditLedger } from "@/lib/domain/audit";
import type { IdempotencyStore } from "@/lib/domain/idempotency";

export interface ControlPlaneTransaction<TStores> {
  stores: TStores;
  audit: AuditLedger;
  idempotency: IdempotencyStore;
}

export interface ControlPlaneTransactionManager<TStores> {
  /**
   * Production adapters MUST map this callback to one real atomic database
   * transaction. No authoritative state may escape if the callback throws.
   */
  run<T>(operation: (transaction: ControlPlaneTransaction<TStores>) => Promise<T>): Promise<T>;
}
