import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { OwnerIntentRecord, OwnerIntentStore } from "@/lib/control-api/service-adapter";
import type {
  Resource,
  ResourceCapabilityBinding,
  ResourceCostProfile,
  ResourceHealthRecord,
  ResourceIdentityEvidence,
  ResourceLocation,
  ResourceProviderBinding,
  ResourceTrustEvidence
} from "@/lib/domain/resources";
import type { ResourceEvidenceStore } from "@/lib/domain/services/resource-registry-service";
import type {
  ResourceEnrollmentReadinessRecord,
  ResourceEnrollmentReadinessStore
} from "@/lib/resources/enrollment";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";
import { PostgresEntityStore } from "@/lib/persistence/postgres/authority-stores";

export class PostgresOwnerIntentStore implements OwnerIntentStore {
  constructor(private readonly db: SqlQueryable) {}

  async create(record: OwnerIntentRecord, idempotencyKey: string) {
    const inserted = await this.db.query(
      `INSERT INTO owner_intents
        (id,portfolio_id,company_id,user_id,idempotency_key,received_at,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (portfolio_id,company_id,idempotency_key) DO NOTHING`,
      [
        record.id,
        record.portfolioId,
        record.companyId,
        record.userId,
        idempotencyKey,
        record.receivedAt,
        JSON.stringify(record)
      ]
    );
    if (inserted.rowCount === 1) return record;

    const existing = await this.db.query<{ payload: OwnerIntentRecord }>(
      `SELECT payload FROM owner_intents
       WHERE portfolio_id=$1 AND company_id=$2 AND idempotency_key=$3`,
      [record.portfolioId, record.companyId, idempotencyKey]
    );
    const prior = existing.rows[0]?.payload;
    if (
      prior
      && prior.userId === record.userId
      && prior.message === record.message
      && prior.channel === record.channel
    ) return prior;
    throw new ControlPlaneError("IDEMPOTENCY_CONFLICT", "Owner intent idempotency key conflicts with prior content");
  }
}

type ResourceEvidence =
  | ResourceIdentityEvidence
  | ResourceTrustEvidence
  | ResourceHealthRecord
  | ResourceCapabilityBinding
  | ResourceLocation
  | ResourceCostProfile
  | ResourceProviderBinding;

export class PostgresResourceEvidenceStore<T extends ResourceEvidence>
  implements ResourceEvidenceStore<T> {
  constructor(
    private readonly db: SqlQueryable,
    private readonly evidenceKind: string
  ) {}

  async append(record: T) {
    try {
      await this.db.query(
        `INSERT INTO resource_evidence
          (evidence_kind,id,resource_id,portfolio_id,company_id,observed_at,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          this.evidenceKind,
          record.id,
          record.resourceId,
          record.portfolioId,
          record.companyId,
          record.observedAt,
          JSON.stringify(record)
        ]
      );
    } catch (error) {
      if (
        error
        && typeof error === "object"
        && "code" in error
        && (error as { code?: string }).code === "23505"
      ) {
        throw new ControlPlaneError("CONFLICT", "Resource evidence already exists");
      }
      throw error;
    }
  }

  async listByResourceId(resourceId: string) {
    const result = await this.db.query<{ payload: T }>(
      `SELECT payload FROM resource_evidence
       WHERE evidence_kind=$1 AND resource_id=$2
       ORDER BY observed_at,id`,
      [this.evidenceKind, resourceId]
    );
    return result.rows.map((row) => row.payload);
  }
}

export class PostgresResourceEnrollmentReadinessStore
  implements ResourceEnrollmentReadinessStore {
  private readonly resources: PostgresEntityStore<Resource>;

  constructor(db: SqlQueryable) {
    this.resources = new PostgresEntityStore<Resource>(db, "resource");
  }

  async get(resourceId: string): Promise<ResourceEnrollmentReadinessRecord | null> {
    const resource = await this.resources.get(resourceId);
    if (!resource) return null;
    const evidenceId = [
      ...resource.providerBindingIds,
      ...resource.healthRecordIds,
      ...resource.trustEvidenceIds,
      ...resource.identityEvidenceIds
    ].at(-1) ?? `resource-ready:${resource.id}:v${resource.version}`;

    return {
      resourceId: resource.id,
      portfolioId: resource.portfolioId,
      companyId: resource.companyId,
      ready: resource.state === "ready",
      evidenceId
    };
  }
}
