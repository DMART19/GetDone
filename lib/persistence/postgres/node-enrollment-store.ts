import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  NodeBootstrapRecord,
  NodeEnrollmentChallengeRecord,
  NodeIdentityCredential,
  NodeEnrollmentChallengeState
} from "@/lib/nodes/identity";
import type { PostgresTransactionalDatabase, SqlQueryable } from "@/lib/persistence/postgres/client";

export interface CompleteNodeBootstrapInput {
  tokenHash: string;
  nonceHash: string;
  consumedAt: string;
  node: NodeBootstrapRecord;
  credential: NodeIdentityCredential;
}

export interface CompletedNodeBootstrap {
  challenge: NodeEnrollmentChallengeRecord;
  node: NodeBootstrapRecord;
  credential: NodeIdentityCredential;
  replay: boolean;
}

export class PostgresNodeEnrollmentStore {
  constructor(private readonly database: PostgresTransactionalDatabase) {}

  async createChallenge(record: NodeEnrollmentChallengeRecord) {
    const inserted = await this.database.query(
      `INSERT INTO node_enrollment_challenges
        (id,resource_enrollment_id,portfolio_id,company_id,owner_user_id,environment,
         display_name,platform,architecture,protocol_version,token_hash,state,
         issued_at,expires_at,version,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        record.id,
        record.resourceEnrollmentId,
        record.portfolioId,
        record.companyId,
        record.ownerUserId,
        record.environment,
        record.displayName,
        record.platform,
        record.architecture,
        record.protocolVersion,
        record.tokenHash,
        record.state,
        record.issuedAt,
        record.expiresAt,
        record.version,
        JSON.stringify(record)
      ]
    );
    if (inserted.rowCount === 1) return record;
    const existing = await this.get(record.id);
    if (
      existing
      && existing.tokenHash === record.tokenHash
      && existing.resourceEnrollmentId === record.resourceEnrollmentId
    ) return existing;
    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Node enrollment challenge already exists with different content"
    );
  }

  async get(id: string): Promise<NodeEnrollmentChallengeRecord | null> {
    return this.readOne(this.database, "id=$1", [id]);
  }

  async getByTokenHash(tokenHash: string): Promise<NodeEnrollmentChallengeRecord | null> {
    return this.readOne(this.database, "token_hash=$1", [tokenHash]);
  }

  async listByScope(portfolioId: string, companyId: string) {
    const result = await this.database.query<{ payload: NodeEnrollmentChallengeRecord }>(
      `SELECT payload FROM node_enrollment_challenges
       WHERE portfolio_id=$1 AND company_id=$2
       ORDER BY issued_at DESC,id`,
      [portfolioId, companyId]
    );
    return result.rows.map((row) => row.payload);
  }

  async setState(
    id: string,
    state: Extract<NodeEnrollmentChallengeState, "expired" | "cancelled">,
    expectedVersion: number
  ) {
    const current = await this.get(id);
    if (!current) throw new ControlPlaneError("NOT_FOUND", "Node enrollment challenge was not found");
    const next: NodeEnrollmentChallengeRecord = {
      ...current,
      state,
      version: expectedVersion + 1
    };
    const result = await this.database.query(
      `UPDATE node_enrollment_challenges
       SET state=$2,version=$3,payload=$4::jsonb
       WHERE id=$1 AND version=$5 AND state='pending'`,
      [id, state, next.version, JSON.stringify(next), expectedVersion]
    );
    if (result.rowCount !== 1) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Node enrollment challenge changed before state update"
      );
    }
    return next;
  }

  async completeBootstrap(input: CompleteNodeBootstrapInput): Promise<CompletedNodeBootstrap> {
    return this.database.transaction(async (db) => {
      const result = await db.query<{
        payload: NodeEnrollmentChallengeRecord;
        state: NodeEnrollmentChallengeState;
        expires_at: Date | string;
        consumed_nonce_hash: string | null;
        node_id: string | null;
      }>(
        `SELECT payload,state,expires_at,consumed_nonce_hash,node_id
         FROM node_enrollment_challenges
         WHERE token_hash=$1
         FOR UPDATE`,
        [input.tokenHash]
      );
      const row = result.rows[0];
      if (!row) {
        throw new ControlPlaneError("UNAUTHENTICATED", "Node enrollment token is invalid");
      }

      if (row.state === "consumed") {
        if (
          row.consumed_nonce_hash !== input.nonceHash
          || !row.node_id
        ) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Node enrollment challenge was already consumed"
          );
        }
        const nodeResult = await db.query<{ payload: NodeBootstrapRecord }>(
          "SELECT payload FROM compute_nodes WHERE id=$1",
          [row.node_id]
        );
        const credentialResult = await db.query<{ payload: NodeIdentityCredential }>(
          `SELECT payload FROM node_identity_credentials
           WHERE node_id=$1 AND revoked_at IS NULL`,
          [row.node_id]
        );
        const node = nodeResult.rows[0]?.payload;
        const credential = credentialResult.rows[0]?.payload;
        if (!node || !credential) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Consumed Node enrollment lost authoritative identity records"
          );
        }
        return {
          challenge: row.payload,
          node,
          credential,
          replay: true
        };
      }

      if (row.state !== "pending") {
        throw new ControlPlaneError(
          "FORBIDDEN",
          `Node enrollment challenge is ${row.state}`
        );
      }
      if (Date.parse(String(row.expires_at)) <= Date.parse(input.consumedAt)) {
        throw new ControlPlaneError("FORBIDDEN", "Node enrollment challenge has expired");
      }

      await db.query(
        `INSERT INTO compute_nodes
          (id,portfolio_id,company_id,owner_user_id,resource_enrollment_id,resource_id,
           display_name,platform,architecture,agent_version,protocol_version,lifecycle_state,
           version,created_at,updated_at,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
        [
          input.node.id,
          input.node.portfolioId,
          input.node.companyId,
          input.node.ownerUserId,
          input.node.resourceEnrollmentId,
          input.node.resourceId ?? null,
          input.node.displayName,
          input.node.platform,
          input.node.architecture,
          input.node.agentVersion,
          input.node.protocolVersion,
          input.node.lifecycleState,
          input.node.version,
          input.node.createdAt,
          input.node.updatedAt,
          JSON.stringify(input.node)
        ]
      );

      await db.query(
        `INSERT INTO node_identity_credentials
          (id,node_id,serial_number,public_key_fingerprint,certificate_pem,
           certificate_chain_pem,credential_hash,issued_at,expires_at,version,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
        [
          input.credential.id,
          input.credential.nodeId,
          input.credential.serialNumber,
          input.credential.publicKeyFingerprint,
          input.credential.certificatePem,
          input.credential.certificateChainPem,
          input.credential.credentialHash,
          input.credential.issuedAt,
          input.credential.expiresAt,
          input.credential.version,
          JSON.stringify(input.credential)
        ]
      );

      const challenge: NodeEnrollmentChallengeRecord = {
        ...row.payload,
        state: "consumed",
        consumedAt: input.consumedAt,
        consumedNonceHash: input.nonceHash,
        nodeId: input.node.id,
        version: row.payload.version + 1
      };
      const updated = await db.query(
        `UPDATE node_enrollment_challenges
         SET state='consumed',consumed_at=$2,consumed_nonce_hash=$3,node_id=$4,
             version=$5,payload=$6::jsonb
         WHERE id=$1 AND state='pending' AND version=$7`,
        [
          challenge.id,
          input.consumedAt,
          input.nonceHash,
          input.node.id,
          challenge.version,
          JSON.stringify(challenge),
          row.payload.version
        ]
      );
      if (updated.rowCount !== 1) {
        throw new ControlPlaneError(
          "CONFLICT",
          "Node enrollment challenge changed before atomic bootstrap completion"
        );
      }

      return { challenge, node: input.node, credential: input.credential, replay: false };
    });
  }

  private async readOne(
    db: SqlQueryable,
    predicate: string,
    values: readonly unknown[]
  ) {
    const result = await db.query<{ payload: NodeEnrollmentChallengeRecord }>(
      `SELECT payload FROM node_enrollment_challenges WHERE ${predicate}`,
      values
    );
    return result.rows[0]?.payload ?? null;
  }
}
