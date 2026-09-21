import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import {
  PostgresNodeInventoryStore,
  type NodeInventoryRecord
} from "@/lib/persistence/postgres/node-inventory-store";

interface ResponseSpec {
  rows?: QueryResultRow[];
  rowCount?: number;
}

class ScriptedDb {
  calls: string[] = [];
  constructor(private readonly responses: ResponseSpec[]) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string
  ): Promise<QueryResult<R>> {
    this.calls.push(text.replace(/\s+/g, " ").trim());
    const response = this.responses.shift() ?? { rows: [], rowCount: 0 };
    return {
      command: "",
      rowCount: response.rowCount ?? response.rows?.length ?? 0,
      oid: 0,
      fields: [],
      rows: (response.rows ?? []) as R[]
    };
  }
}

const record: NodeInventoryRecord = {
  id: "inventory-1",
  nodeId: "node-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  architecture: "x86_64",
  inventoryHash: "a".repeat(64),
  discoveredAt: "2026-09-21T12:00:00Z",
  receivedAt: "2026-09-21T12:01:00Z",
  inventory: {
    nodeId: "node-1",
    platform: "linux",
    architecture: "x86_64",
    cpu: {
      architecture: "x86_64",
      model: "Xeon",
      sockets: 1,
      physicalCores: 2,
      logicalThreads: 4,
      virtualizationSupported: true
    },
    memory: { totalBytes: 1024 },
    gpus: [],
    storage: [],
    network: [],
    operatingSystem: {
      distribution: "Ubuntu",
      version: "24.04",
      kernel: "6.8"
    },
    cgroups: { version: 2, available: true },
    discoveredAt: "2026-09-21T12:00:00Z",
    inventoryHash: "a".repeat(64)
  }
};

describe("PostgresNodeInventoryStore", () => {
  it("migration creates immutable hash-keyed inventory snapshots", () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), "migrations/2026-09-21.3_phase28_inventory.sql"),
      "utf8"
    );
    expect(sql).toContain("node_inventory_snapshots");
    expect(sql).toContain("UNIQUE(node_id, inventory_hash)");
    expect(sql).toContain("node_inventory_latest_idx");
    expect(sql).toContain("architecture IN ('x86_64','arm64')");
  });

  it("inserts a new snapshot", async () => {
    const db = new ScriptedDb([{ rowCount: 1 }]);
    const result = await new PostgresNodeInventoryStore(db as never).put(record);
    expect(result).toBe(record);
    expect(db.calls[0]).toContain("ON CONFLICT (node_id,inventory_hash) DO NOTHING");
  });

  it("returns exact persisted replay and rejects hash collision mismatch", async () => {
    const replayDb = new ScriptedDb([
      { rowCount: 0 },
      { rows: [{ payload: record }] }
    ]);
    await expect(new PostgresNodeInventoryStore(replayDb as never).put(record))
      .resolves.toEqual(record);

    const conflictDb = new ScriptedDb([
      { rowCount: 0 },
      {
        rows: [{
          payload: {
            ...record,
            inventory: {
              ...record.inventory,
              operatingSystem: {
                ...record.inventory.operatingSystem,
                kernel: "tampered"
              }
            }
          }
        }]
      }
    ]);
    await expect(new PostgresNodeInventoryStore(conflictDb as never).put(record))
      .rejects.toThrow(/replay does not match/i);
  });

  it("reads the latest inventory deterministically", async () => {
    const db = new ScriptedDb([{ rows: [{ payload: record }] }]);
    const result = await new PostgresNodeInventoryStore(db as never).getLatest("node-1");
    expect(result).toEqual(record);
    expect(db.calls[0]).toContain("ORDER BY discovered_at DESC,received_at DESC");
  });
});
