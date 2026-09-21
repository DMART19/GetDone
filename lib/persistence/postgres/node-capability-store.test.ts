import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  PoolClient,
  QueryResult,
  QueryResultRow
} from "pg";
import type {
  NodeCapability,
  NodeCapabilityProfile
} from "@/lib/nodes/contracts";
import {
  hashNodeCapability,
  hashNodeCapabilityProfile
} from "@/lib/nodes/hashes";
import type {
  PostgresTransactionalDatabase
} from "@/lib/persistence/postgres/client";
import {
  PostgresNodeCapabilityStore,
  type NodeCapabilityProfileRecord,
  type NodeCapabilityReconciliationResult
} from "@/lib/persistence/postgres/node-capability-store";

interface ResponseSpec {
  rows?: QueryResultRow[];
  rowCount?: number;
}

class ScriptedDb implements PostgresTransactionalDatabase {
  readonly calls: string[] = [];
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

  async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
    return operation(this as unknown as PoolClient);
  }
}

function capability(
  status: NodeCapability["status"],
  observedAt = "2026-09-21T18:00:00Z"
): NodeCapability {
  const base: Omit<NodeCapability, "capabilityHash"> = {
    id: "node-capability-runtime-docker",
    nodeId: "node-1",
    name: "runtime.docker",
    version: "Docker version 28.0.0",
    status,
    evidenceIds: ["cap-evidence-docker"],
    constraints: { runtime: "docker" },
    observedAt
  };
  return {
    ...base,
    capabilityHash: hashNodeCapability(base)
  };
}

function profileRecord(
  capabilities: readonly NodeCapability[],
  observedAt = "2026-09-21T18:00:00Z",
  receivedAt = "2026-09-21T18:00:05Z"
): NodeCapabilityProfileRecord {
  const profileBase: Omit<NodeCapabilityProfile, "profileHash"> = {
    nodeId: "node-1",
    observedAt,
    capabilities
  };
  const profile: NodeCapabilityProfile = {
    ...profileBase,
    profileHash: hashNodeCapabilityProfile(profileBase)
  };
  return {
    id: `profile-${profile.profileHash.slice(0, 16)}`,
    nodeId: "node-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    profileHash: profile.profileHash,
    observedAt,
    receivedAt,
    profile
  };
}

describe("PostgresNodeCapabilityStore", () => {
  it("migration separates immutable profiles, current state, and history", () => {
    const sql = fs.readFileSync(
      path.join(
        process.cwd(),
        "migrations/2026-09-21.4_phase28_capabilities.sql"
      ),
      "utf8"
    );
    for (const required of [
      "node_capability_profiles",
      "node_capability_state",
      "node_capability_history",
      "UNIQUE(node_id, profile_hash)",
      "PRIMARY KEY(node_id, capability_name)"
    ]) {
      expect(sql).toContain(required);
    }
  });

  it("reconciles a new full profile under the Node row lock", async () => {
    const record = profileRecord([capability("validated")]);
    const db = new ScriptedDb([
      { rowCount: 1 },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    const result = await new PostgresNodeCapabilityStore(db)
      .replaceProfile(record);
    expect(result).toMatchObject({
      replay: false,
      currentCapabilities: [{ name: "runtime.docker", status: "validated" }]
    });
    expect(db.calls[0]).toContain("compute_nodes");
    expect(db.calls[0]).toContain("FOR UPDATE");
    expect(db.calls.some((call) =>
      call.includes("INSERT INTO node_capability_profiles")
    )).toBe(true);
  });

  it("turns a previously validated missing capability into a disabled tombstone", async () => {
    const previous = capability("validated", "2026-09-21T18:00:00Z");
    const nextRecord = profileRecord(
      [],
      "2026-09-21T18:05:00Z",
      "2026-09-21T18:05:05Z"
    );
    const db = new ScriptedDb([
      { rowCount: 1 },
      { rows: [] },
      {
        rows: [{
          observed_at: "2026-09-21T18:00:00Z",
          profile_hash: "previous"
        }]
      },
      { rows: [{ payload: previous }] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    const result = await new PostgresNodeCapabilityStore(db)
      .replaceProfile(nextRecord);
    expect(result.removedCapabilities).toHaveLength(1);
    expect(result.removedCapabilities[0]).toMatchObject({
      name: "runtime.docker",
      status: "disabled"
    });
    expect(result.removedCapabilities[0].constraints).toMatchObject({
      removalReason: "absent-from-full-profile"
    });
  });

  it("persists validated-to-detected downgrade instead of preserving stale validation", async () => {
    const previous = capability("validated", "2026-09-21T18:00:00Z");
    const downgraded = capability("detected", "2026-09-21T18:05:00Z");
    const nextRecord = profileRecord(
      [downgraded],
      "2026-09-21T18:05:00Z",
      "2026-09-21T18:05:05Z"
    );
    const db = new ScriptedDb([
      { rowCount: 1 },
      { rows: [] },
      {
        rows: [{
          observed_at: "2026-09-21T18:00:00Z",
          profile_hash: "previous"
        }]
      },
      { rows: [{ payload: previous }] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    const result = await new PostgresNodeCapabilityStore(db)
      .replaceProfile(nextRecord);
    expect(result.removedCapabilities).toEqual([]);
    expect(result.currentCapabilities).toMatchObject([
      { name: "runtime.docker", status: "detected" }
    ]);
  });

  it("returns exact persisted result for an idempotent profile replay", async () => {
    const record = profileRecord([capability("validated")]);
    const persisted: NodeCapabilityReconciliationResult = {
      profile: record,
      currentCapabilities: record.profile.capabilities,
      removedCapabilities: [],
      replay: false
    };
    const db = new ScriptedDb([
      { rowCount: 1 },
      { rows: [{ payload: record, result_payload: persisted }] }
    ]);
    const result = await new PostgresNodeCapabilityStore(db)
      .replaceProfile(record);
    expect(result.replay).toBe(true);
    expect(result.currentCapabilities).toEqual(record.profile.capabilities);
    expect(db.calls).toHaveLength(2);
  });

  it("rejects stale and same-timestamp-different profile updates", async () => {
    const stale = profileRecord(
      [],
      "2026-09-21T17:59:00Z",
      "2026-09-21T18:05:00Z"
    );
    const staleDb = new ScriptedDb([
      { rowCount: 1 },
      { rows: [] },
      {
        rows: [{
          observed_at: "2026-09-21T18:00:00Z",
          profile_hash: "newer"
        }]
      }
    ]);
    await expect(new PostgresNodeCapabilityStore(staleDb)
      .replaceProfile(stale)).rejects.toThrow(/older than authoritative/i);

    const collision = profileRecord(
      [],
      "2026-09-21T18:00:00Z",
      "2026-09-21T18:05:00Z"
    );
    const collisionDb = new ScriptedDb([
      { rowCount: 1 },
      { rows: [] },
      {
        rows: [{
          observed_at: "2026-09-21T18:00:00Z",
          profile_hash: "different"
        }]
      }
    ]);
    await expect(new PostgresNodeCapabilityStore(collisionDb)
      .replaceProfile(collision)).rejects.toThrow(/timestamp collides/i);
  });
});
