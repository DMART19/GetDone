import type { PoolClient } from "pg";
import type {
  ControlPlaneTransaction,
  ControlPlaneTransactionManager
} from "@/lib/domain/control-plane-transaction";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import {
  PostgresAuditLedger,
  PostgresIdempotencyStore
} from "@/lib/persistence/postgres/authority-stores";

export type PostgresStoreFactory<TStores> = (client: PoolClient) => TStores;

export class PostgresControlPlaneTransactionManager<TStores>
  implements ControlPlaneTransactionManager<TStores> {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly createStores: PostgresStoreFactory<TStores>
  ) {}

  run<T>(
    operation: (transaction: ControlPlaneTransaction<TStores>) => Promise<T>
  ): Promise<T> {
    return this.database.transaction(async (client) => {
      const transaction: ControlPlaneTransaction<TStores> = {
        stores: this.createStores(client),
        audit: new PostgresAuditLedger(client),
        idempotency: new PostgresIdempotencyStore(client)
      };
      return operation(transaction);
    });
  }
}
