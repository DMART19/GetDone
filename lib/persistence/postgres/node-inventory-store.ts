import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { HardwareInventory } from "@/lib/nodes/contracts";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";

export interface NodeInventoryRecord {
  id: string;
  nodeId: string;
  portfolioId: string;
  companyId: string;
  architecture: HardwareInventory["architecture"];
  inventoryHash: string;
  discoveredAt: string;
  receivedAt: string;
  inventory: HardwareInventory;
}

export interface NodeInventoryStore {
  put(record: NodeInventoryRecord): Promise<NodeInventoryRecord>;
  getLatest(nodeId: string): Promise<NodeInventoryRecord | null>;
}

export class PostgresNodeInventoryStore implements NodeInventoryStore {
  constructor(private readonly db: SqlQueryable) {}

  async put(record: NodeInventoryRecord) {
    const inserted = await this.db.query(
      `INSERT INTO node_inventory_snapshots
        (id,node_id,portfolio_id,company_id,architecture,inventory_hash,
         discovered_at,received_at,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (node_id,inventory_hash) DO NOTHING`,
      [
        record.id,
        record.nodeId,
        record.portfolioId,
        record.companyId,
        record.architecture,
        record.inventoryHash,
        record.discoveredAt,
        record.receivedAt,
        JSON.stringify(record)
      ]
    );
    if (inserted.rowCount === 1) return record;

    const replay = await this.db.query<{ payload: NodeInventoryRecord }>(
      `SELECT payload FROM node_inventory_snapshots
       WHERE node_id=$1 AND inventory_hash=$2`,
      [record.nodeId, record.inventoryHash]
    );
    const existing = replay.rows[0]?.payload;
    if (
      existing
      && existing.nodeId === record.nodeId
      && existing.inventoryHash === record.inventoryHash
      && JSON.stringify(existing.inventory) === JSON.stringify(record.inventory)
    ) {
      return existing;
    }
    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Node inventory hash replay does not match persisted inventory"
    );
  }

  async getLatest(nodeId: string) {
    const result = await this.db.query<{ payload: NodeInventoryRecord }>(
      `SELECT payload FROM node_inventory_snapshots
       WHERE node_id=$1
       ORDER BY discovered_at DESC,received_at DESC
       LIMIT 1`,
      [nodeId]
    );
    return result.rows[0]?.payload ?? null;
  }
}
