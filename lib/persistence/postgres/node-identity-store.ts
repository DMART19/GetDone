import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { NodeIdentityCredential } from "@/lib/nodes/identity";
import type { PostgresTransactionalDatabase, SqlQueryable } from "@/lib/persistence/postgres/client";

export interface NodeCertificateRotationRecord {
  id: string;
  nodeId: string;
  previousCredentialId: string;
  nextCredentialId: string;
  requestedAt: string;
  completedAt: string;
  rotationHash: string;
}

export class PostgresNodeIdentityStore {
  constructor(private readonly database: PostgresTransactionalDatabase) {}

  async get(id: string): Promise<NodeIdentityCredential | null> {
    return this.readOne(this.database, "id=$1", [id]);
  }

  async getActive(nodeId: string): Promise<NodeIdentityCredential | null> {
    return this.readOne(
      this.database,
      "node_id=$1 AND revoked_at IS NULL",
      [nodeId]
    );
  }

  async revoke(
    credentialId: string,
    reason: string,
    revokedAt: string,
    expectedVersion: number
  ) {
    const current = await this.get(credentialId);
    if (!current) throw new ControlPlaneError("NOT_FOUND", "Node identity credential was not found");
    const next: NodeIdentityCredential = {
      ...current,
      revokedAt,
      revocationReason: reason,
      version: expectedVersion + 1
    };
    const result = await this.database.query(
      `UPDATE node_identity_credentials
       SET revoked_at=$2,revocation_reason=$3,version=$4,payload=$5::jsonb
       WHERE id=$1 AND version=$6 AND revoked_at IS NULL`,
      [
        credentialId,
        revokedAt,
        reason,
        next.version,
        JSON.stringify(next),
        expectedVersion
      ]
    );
    if (result.rowCount !== 1) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Node identity credential changed before revocation"
      );
    }
    return next;
  }

  async rotateAtomic(
    current: NodeIdentityCredential,
    next: NodeIdentityCredential,
    requestedAt: string,
    completedAt: string
  ) {
    return this.database.transaction(async (db) => {
      const locked = await db.query<{ payload: NodeIdentityCredential }>(
        `SELECT payload FROM node_identity_credentials
         WHERE id=$1 AND node_id=$2 AND revoked_at IS NULL
         FOR UPDATE`,
        [current.id, current.nodeId]
      );
      const persisted = locked.rows[0]?.payload;
      if (
        !persisted
        || persisted.credentialHash !== current.credentialHash
        || next.nodeId !== current.nodeId
      ) {
        throw new ControlPlaneError(
          "CONFLICT",
          "Node credential rotation lineage is stale"
        );
      }

      const revokedCurrent: NodeIdentityCredential = {
        ...persisted,
        revokedAt: completedAt,
        revocationReason: "rotated",
        version: persisted.version + 1
      };
      await db.query(
        `UPDATE node_identity_credentials
         SET revoked_at=$2,revocation_reason='rotated',version=$3,payload=$4::jsonb
         WHERE id=$1`,
        [persisted.id, completedAt, revokedCurrent.version, JSON.stringify(revokedCurrent)]
      );
      await db.query(
        `INSERT INTO node_identity_credentials
          (id,node_id,serial_number,public_key_fingerprint,certificate_pem,
           certificate_chain_pem,credential_hash,issued_at,expires_at,version,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
        [
          next.id,
          next.nodeId,
          next.serialNumber,
          next.publicKeyFingerprint,
          next.certificatePem,
          next.certificateChainPem,
          next.credentialHash,
          next.issuedAt,
          next.expiresAt,
          next.version,
          JSON.stringify(next)
        ]
      );
      const base = {
        id: crypto.randomUUID(),
        nodeId: current.nodeId,
        previousCredentialId: current.id,
        nextCredentialId: next.id,
        requestedAt,
        completedAt
      };
      const rotation: NodeCertificateRotationRecord = {
        ...base,
        rotationHash: sha256Hex(base)
      };
      await db.query(
        `INSERT INTO node_certificate_rotations
          (id,node_id,previous_credential_id,next_credential_id,requested_at,
           completed_at,rotation_hash,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          rotation.id,
          rotation.nodeId,
          rotation.previousCredentialId,
          rotation.nextCredentialId,
          rotation.requestedAt,
          rotation.completedAt,
          rotation.rotationHash,
          JSON.stringify(rotation)
        ]
      );
      return { previous: revokedCurrent, next, rotation };
    });
  }

  private async readOne(
    db: SqlQueryable,
    predicate: string,
    values: readonly unknown[]
  ) {
    const result = await db.query<{ payload: NodeIdentityCredential }>(
      `SELECT payload FROM node_identity_credentials WHERE ${predicate}`,
      values
    );
    return result.rows[0]?.payload ?? null;
  }
}
