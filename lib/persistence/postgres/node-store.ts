import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { NodeBootstrapRecord } from "@/lib/nodes/identity";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";

export class PostgresNodeStore {
  constructor(private readonly db: SqlQueryable) {}

  async create(record: NodeBootstrapRecord) {
    const inserted = await this.db.query(
      `INSERT INTO compute_nodes
        (id,portfolio_id,company_id,owner_user_id,resource_enrollment_id,resource_id,
         display_name,platform,architecture,agent_version,protocol_version,lifecycle_state,
         version,created_at,updated_at,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        record.id,
        record.portfolioId,
        record.companyId,
        record.ownerUserId,
        record.resourceEnrollmentId,
        record.resourceId ?? null,
        record.displayName,
        record.platform,
        record.architecture,
        record.agentVersion,
        record.protocolVersion,
        record.lifecycleState,
        record.version,
        record.createdAt,
        record.updatedAt,
        JSON.stringify(record)
      ]
    );
    if (inserted.rowCount === 1) return record;
    const existing = await this.get(record.id);
    if (existing && JSON.stringify(existing) === JSON.stringify(record)) return existing;
    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Compute node ID already exists with different authoritative content"
    );
  }

  async get(id: string): Promise<NodeBootstrapRecord | null> {
    const result = await this.db.query<{ payload: NodeBootstrapRecord }>(
      "SELECT payload FROM compute_nodes WHERE id=$1",
      [id]
    );
    return result.rows[0]?.payload ?? null;
  }

  async listByScope(portfolioId: string, companyId: string) {
    const result = await this.db.query<{ payload: NodeBootstrapRecord }>(
      `SELECT payload FROM compute_nodes
       WHERE portfolio_id=$1 AND company_id=$2
       ORDER BY updated_at DESC,id`,
      [portfolioId, companyId]
    );
    return result.rows.map((row) => row.payload);
  }

  async save(next: NodeBootstrapRecord, expectedVersion: number) {
    if (next.version !== expectedVersion + 1) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Compute node version must advance exactly once"
      );
    }
    const result = await this.db.query(
      `UPDATE compute_nodes
       SET resource_id=$2,display_name=$3,agent_version=$4,protocol_version=$5,
           lifecycle_state=$6,version=$7,updated_at=$8,payload=$9::jsonb
       WHERE id=$1 AND version=$10`,
      [
        next.id,
        next.resourceId ?? null,
        next.displayName,
        next.agentVersion,
        next.protocolVersion,
        next.lifecycleState,
        next.version,
        next.updatedAt,
        JSON.stringify(next),
        expectedVersion
      ]
    );
    if (result.rowCount !== 1) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Compute node changed before compare-and-swap persistence"
      );
    }
  }
}
