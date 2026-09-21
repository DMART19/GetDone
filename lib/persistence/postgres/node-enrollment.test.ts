import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  PostgresNodeEnrollmentStore
} from "@/lib/persistence/postgres/node-enrollment-store";
import {
  PostgresNodeIdentityStore
} from "@/lib/persistence/postgres/node-identity-store";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";
import type {
  NodeBootstrapRecord,
  NodeEnrollmentChallengeRecord,
  NodeIdentityCredential
} from "@/lib/nodes/identity";

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
    const response = this.responses.shift() ?? { rows: [], rowCount: 1 };
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

const challenge: NodeEnrollmentChallengeRecord = {
  id: "challenge-1",
  resourceEnrollmentId: "enrollment-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  ownerUserId: "owner-a",
  environment: "development",
  displayName: "Server",
  platform: "linux",
  architecture: "x86_64",
  protocolVersion: "1.0.0",
  tokenHash: "token-hash",
  state: "pending",
  issuedAt: "2026-09-21T12:00:00Z",
  expiresAt: "2026-09-21T12:15:00Z",
  version: 1
};

const node: NodeBootstrapRecord = {
  id: "node-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  ownerUserId: "owner-a",
  resourceEnrollmentId: "enrollment-1",
  displayName: "Server",
  platform: "linux",
  architecture: "x86_64",
  agentVersion: "0.2.0",
  protocolVersion: "1.0.0",
  lifecycleState: "authenticated",
  version: 1,
  createdAt: "2026-09-21T12:05:00Z",
  updatedAt: "2026-09-21T12:05:00Z"
};

const credential: NodeIdentityCredential = {
  id: "credential-1",
  nodeId: "node-1",
  serialNumber: "serial-1",
  publicKeyFingerprint: "fingerprint",
  certificatePem: "certificate",
  certificateChainPem: "chain",
  credentialHash: "credential-hash",
  issuedAt: "2026-09-21T12:05:00Z",
  expiresAt: "2026-09-22T12:05:00Z",
  version: 1
};

describe("Phase 28.2 PostgreSQL Node persistence", () => {
  it("declares one-time challenge, identity, rotation, and session constraints", () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), "migrations/2026-09-21.2_phase28_nodes.sql"),
      "utf8"
    );
    for (const required of [
      "compute_nodes",
      "node_enrollment_challenges",
      "node_identity_credentials",
      "node_certificate_rotations",
      "node_agent_sessions",
      "token_hash text NOT NULL UNIQUE",
      "serial_number text NOT NULL UNIQUE",
      "node_identity_one_active_credential",
      "expires_at > issued_at"
    ]) {
      expect(sql).toContain(required);
    }
  });

  it("atomically persists node + first identity + consumed challenge", async () => {
    const db = new ScriptedDb([
      {
        rows: [{
          payload: challenge,
          state: "pending",
          expires_at: challenge.expiresAt,
          consumed_nonce_hash: null,
          node_id: null
        }]
      },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    const store = new PostgresNodeEnrollmentStore(db);
    const result = await store.completeBootstrap({
      tokenHash: challenge.tokenHash,
      nonceHash: "nonce-hash",
      consumedAt: "2026-09-21T12:05:00Z",
      node,
      credential
    });
    expect(result.replay).toBe(false);
    expect(result.challenge.state).toBe("consumed");
    expect(db.calls[0]).toContain("FOR UPDATE");
    expect(db.calls.some((call) => call.includes("INSERT INTO compute_nodes"))).toBe(true);
    expect(db.calls.some((call) => call.includes("INSERT INTO node_identity_credentials"))).toBe(true);
  });

  it("replays the same consumed nonce from persisted identity and rejects another nonce", async () => {
    const consumed = {
      ...challenge,
      state: "consumed" as const,
      consumedAt: "2026-09-21T12:05:00Z",
      consumedNonceHash: "nonce-hash",
      nodeId: "node-1",
      version: 2
    };
    const replayDb = new ScriptedDb([
      {
        rows: [{
          payload: consumed,
          consumed_nonce_hash: "nonce-hash",
          node_id: "node-1"
        }]
      },
      { rows: [{ payload: node }] },
      { rows: [{ payload: credential }] }
    ]);
    const replay = await new PostgresNodeEnrollmentStore(replayDb)
      .getCompletedBootstrap(challenge.tokenHash, "nonce-hash");
    expect(replay).toMatchObject({ replay: true, node, credential });

    const conflictDb = new ScriptedDb([
      {
        rows: [{
          payload: consumed,
          consumed_nonce_hash: "nonce-hash",
          node_id: "node-1"
        }]
      }
    ]);
    await expect(new PostgresNodeEnrollmentStore(conflictDb)
      .getCompletedBootstrap(challenge.tokenHash, "different-nonce"))
      .rejects.toThrow(/already consumed/i);
  });

  it("persists certificate rotation with exact previous/next lineage", async () => {
    const next: NodeIdentityCredential = {
      ...credential,
      id: "credential-2",
      serialNumber: "serial-2",
      credentialHash: "credential-hash-2",
      issuedAt: "2026-09-21T18:00:00Z",
      expiresAt: "2026-09-22T18:00:00Z"
    };
    const db = new ScriptedDb([
      { rows: [{ payload: credential }] },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    const rotated = await new PostgresNodeIdentityStore(db).rotateAtomic(
      credential,
      next,
      "2026-09-21T17:59:00Z",
      "2026-09-21T18:00:00Z"
    );
    expect(rotated.previous.revocationReason).toBe("rotated");
    expect(rotated.rotation).toMatchObject({
      nodeId: "node-1",
      previousCredentialId: "credential-1",
      nextCredentialId: "credential-2"
    });
    expect(db.calls[0]).toContain("FOR UPDATE");
  });

  it("rejects stale certificate rotation lineage", async () => {
    const db = new ScriptedDb([{ rows: [] }]);
    await expect(new PostgresNodeIdentityStore(db).rotateAtomic(
      credential,
      { ...credential, id: "credential-2", nodeId: "node-1" },
      "2026-09-21T17:59:00Z",
      "2026-09-21T18:00:00Z"
    )).rejects.toThrow(/rotation lineage is stale/i);
  });
});
