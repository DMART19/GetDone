import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type {
  NodeCapability,
  NodeCapabilityProfile
} from "@/lib/nodes/contracts";
import {
  hashNodeCapability
} from "@/lib/nodes/hashes";
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";

export interface NodeCapabilityProfileRecord {
  id: string;
  nodeId: string;
  portfolioId: string;
  companyId: string;
  profileHash: string;
  observedAt: string;
  receivedAt: string;
  profile: NodeCapabilityProfile;
}

export interface NodeCapabilityReconciliationResult {
  profile: NodeCapabilityProfileRecord;
  currentCapabilities: readonly NodeCapability[];
  removedCapabilities: readonly NodeCapability[];
  replay: boolean;
}

export interface NodeCapabilityStore {
  replaceProfile(
    record: NodeCapabilityProfileRecord
  ): Promise<NodeCapabilityReconciliationResult>;
  listCurrent(nodeId: string): Promise<readonly NodeCapability[]>;
  getLatestProfile(nodeId: string): Promise<NodeCapabilityProfileRecord | null>;
}

function disabledTombstone(
  capability: NodeCapability,
  observedAt: string
): NodeCapability {
  const evidenceId = `cap-evidence-removed-${sha256Hex({
    nodeId: capability.nodeId,
    name: capability.name,
    observedAt
  }).slice(0, 24)}`;
  const base: Omit<NodeCapability, "capabilityHash"> = {
    ...capability,
    status: "disabled",
    evidenceIds: Object.freeze([
      ...new Set([...capability.evidenceIds, evidenceId])
    ]),
    constraints: Object.freeze({
      ...capability.constraints,
      removalReason: "absent-from-full-profile"
    }),
    observedAt
  };
  return Object.freeze({
    ...base,
    capabilityHash: hashNodeCapability(base)
  });
}

function historyId(capability: NodeCapability) {
  return `node-cap-history-${sha256Hex({
    nodeId: capability.nodeId,
    name: capability.name,
    capabilityHash: capability.capabilityHash
  }).slice(0, 32)}`;
}

export class PostgresNodeCapabilityStore implements NodeCapabilityStore {
  constructor(private readonly database: PostgresTransactionalDatabase) {}

  async listCurrent(nodeId: string) {
    return this.readCurrent(this.database, nodeId);
  }

  async getLatestProfile(nodeId: string) {
    const result = await this.database.query<{ payload: NodeCapabilityProfileRecord }>(
      `SELECT payload FROM node_capability_profiles
       WHERE node_id=$1
       ORDER BY observed_at DESC,received_at DESC
       LIMIT 1`,
      [nodeId]
    );
    return result.rows[0]?.payload ?? null;
  }

  async replaceProfile(
    record: NodeCapabilityProfileRecord
  ): Promise<NodeCapabilityReconciliationResult> {
    return this.database.transaction(async (db) => {
      const nodeLock = await db.query(
        "SELECT id FROM compute_nodes WHERE id=$1 FOR UPDATE",
        [record.nodeId]
      );
      if (nodeLock.rowCount !== 1) {
        throw new ControlPlaneError("NOT_FOUND", "Enrolled Node was not found");
      }

      const replayResult = await db.query<{
        payload: NodeCapabilityProfileRecord;
        result_payload: NodeCapabilityReconciliationResult;
      }>(
        `SELECT payload,result_payload
         FROM node_capability_profiles
         WHERE node_id=$1 AND profile_hash=$2`,
        [record.nodeId, record.profileHash]
      );
      const replay = replayResult.rows[0];
      if (replay) {
        if (JSON.stringify(replay.payload.profile) !== JSON.stringify(record.profile)) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Node capability profile hash replay differs from persisted content"
          );
        }
        return Object.freeze({
          ...replay.result_payload,
          replay: true
        });
      }

      const latestResult = await db.query<{
        observed_at: Date | string;
        profile_hash: string;
      }>(
        `SELECT observed_at,profile_hash
         FROM node_capability_profiles
         WHERE node_id=$1
         ORDER BY observed_at DESC,received_at DESC
         LIMIT 1`,
        [record.nodeId]
      );
      const latest = latestResult.rows[0];
      if (latest) {
        const previousAt = Date.parse(String(latest.observed_at));
        const nextAt = Date.parse(record.observedAt);
        if (nextAt < previousAt) {
          throw new ControlPlaneError(
            "CONFLICT",
            "Node capability profile is older than authoritative current state"
          );
        }
        if (nextAt === previousAt && latest.profile_hash !== record.profileHash) {
          throw new ControlPlaneError(
            "CONFLICT",
            "Node capability profile timestamp collides with different content"
          );
        }
      }

      const previous = await this.readCurrent(db, record.nodeId, true);
      const submitted = new Map(
        record.profile.capabilities.map((capability) => [capability.name, capability])
      );
      const removed = previous
        .filter(
          (capability) =>
            capability.status !== "disabled"
            && !submitted.has(capability.name)
        )
        .map((capability) => disabledTombstone(capability, record.observedAt));

      const nextCurrent = [
        ...record.profile.capabilities,
        ...removed
      ].sort((left, right) => left.name.localeCompare(right.name));

      const result: NodeCapabilityReconciliationResult = Object.freeze({
        profile: record,
        currentCapabilities: Object.freeze(nextCurrent),
        removedCapabilities: Object.freeze(removed),
        replay: false
      });

      await db.query(
        `INSERT INTO node_capability_profiles
          (id,node_id,portfolio_id,company_id,profile_hash,observed_at,received_at,payload,result_payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
        [
          record.id,
          record.nodeId,
          record.portfolioId,
          record.companyId,
          record.profileHash,
          record.observedAt,
          record.receivedAt,
          JSON.stringify(record),
          JSON.stringify(result)
        ]
      );

      for (const capability of nextCurrent) {
        await db.query(
          `INSERT INTO node_capability_state
            (node_id,capability_name,capability_hash,status,observed_at,payload)
           VALUES($1,$2,$3,$4,$5,$6::jsonb)
           ON CONFLICT (node_id,capability_name) DO UPDATE
           SET capability_hash=EXCLUDED.capability_hash,
               status=EXCLUDED.status,
               observed_at=EXCLUDED.observed_at,
               payload=EXCLUDED.payload`,
          [
            capability.nodeId,
            capability.name,
            capability.capabilityHash,
            capability.status,
            capability.observedAt,
            JSON.stringify(capability)
          ]
        );
        await db.query(
          `INSERT INTO node_capability_history
            (id,node_id,capability_name,capability_hash,status,observed_at,recorded_at,payload)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
           ON CONFLICT (node_id,capability_name,capability_hash) DO NOTHING`,
          [
            historyId(capability),
            capability.nodeId,
            capability.name,
            capability.capabilityHash,
            capability.status,
            capability.observedAt,
            record.receivedAt,
            JSON.stringify(capability)
          ]
        );
      }

      return result;
    });
  }

  private async readCurrent(
    db: SqlQueryable,
    nodeId: string,
    forUpdate = false
  ) {
    const result = await db.query<{ payload: NodeCapability }>(
      `SELECT payload FROM node_capability_state
       WHERE node_id=$1
       ORDER BY capability_name
       ${forUpdate ? "FOR UPDATE" : ""}`,
      [nodeId]
    );
    return result.rows.map((row) => row.payload);
  }
}
