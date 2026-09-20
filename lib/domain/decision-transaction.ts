import type { AuditLedger } from "@/lib/domain/audit";
import type { DecisionAuthorityStore } from "@/lib/domain/decision-service";
import type { IdempotencyStore } from "@/lib/domain/idempotency";

/**
 * Persistence adapters must implement this boundary with one real database
 * transaction. Decision state, audit append, and idempotency completion must
 * commit together or roll back together.
 */
export interface DecisionTransaction {
  decisions: DecisionAuthorityStore;
  audit: AuditLedger;
  idempotency: IdempotencyStore;
}

export interface DecisionTransactionManager {
  run<T>(operation: (transaction: DecisionTransaction) => Promise<T>): Promise<T>;
}
