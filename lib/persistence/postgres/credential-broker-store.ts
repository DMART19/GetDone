import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { CredentialLease, CredentialUsageAudit } from "@/lib/credentials/broker";
import type { CredentialLeaseReader, CredentialUsageAuditWriter } from "@/lib/credentials/runtime-broker";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";

export class PostgresCredentialBrokerStore implements CredentialLeaseReader, CredentialUsageAuditWriter {
  constructor(private readonly db: SqlQueryable) {}

  async putLease(lease: CredentialLease) {
    const result = await this.db.query(
      `INSERT INTO credential_leases
        (id,portfolio_id,company_id,job_id,resource_id,provider_id,capability,status,expires_at,lease_hash,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT(id) DO UPDATE
       SET status=EXCLUDED.status,
           expires_at=EXCLUDED.expires_at,
           lease_hash=EXCLUDED.lease_hash,
           payload=EXCLUDED.payload
       WHERE credential_leases.lease_hash=EXCLUDED.lease_hash`,
      [
        lease.id,
        lease.portfolioId,
        lease.companyId,
        lease.jobId,
        lease.resourceId,
        lease.providerId,
        lease.capability,
        lease.status,
        lease.expiresAt,
        lease.leaseHash,
        JSON.stringify(lease)
      ]
    );
    if (result.rowCount === 1) return;
    const existing = await this.get(lease.id);
    if (existing?.leaseHash === lease.leaseHash) return;
    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Credential lease ID already exists with different authoritative content"
    );
  }

  async get(id: string): Promise<CredentialLease | null> {
    const result = await this.db.query<{ payload: CredentialLease }>(
      "SELECT payload FROM credential_leases WHERE id=$1",
      [id]
    );
    return result.rows[0]?.payload ?? null;
  }

  async append(record: CredentialUsageAudit): Promise<void> {
    await this.db.query(
      `INSERT INTO credential_usage_audits
        (id,portfolio_id,company_id,lease_id,job_id,provider_id,capability,used_at,audit_hash,payload)
       SELECT $1,lease.portfolio_id,lease.company_id,$2,$3,$4,$5,$6,$7,$8::jsonb
       FROM credential_leases lease
       WHERE lease.id=$2
       ON CONFLICT(id) DO NOTHING`,
      [
        record.id,
        record.leaseId,
        record.jobId,
        record.providerId,
        record.capability,
        record.usedAt,
        record.auditHash,
        JSON.stringify(record)
      ]
    );
  }

  async listUsage(leaseId: string): Promise<readonly CredentialUsageAudit[]> {
    const result = await this.db.query<{ payload: CredentialUsageAudit }>(
      "SELECT payload FROM credential_usage_audits WHERE lease_id=$1 ORDER BY used_at,id",
      [leaseId]
    );
    return result.rows.map((row) => row.payload);
  }
}
