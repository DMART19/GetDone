import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { createAuditEvent } from "@/lib/domain/audit";
import { claimIdempotency } from "@/lib/domain/idempotency";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import type { ObjectiveIntakeStore, ObjectiveRecord } from "@/lib/domain/objective-inbox";
import {
  createOwnerIntentOrchestrationRun,
  ownerIntentOrchestrationStartIdempotencyKey
} from "@/lib/orchestration/owner-intent-flow";
import type { OwnerIntentStore } from "@/lib/control-api/service-adapter";
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
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";
import {
  PostgresAuditLedger,
  PostgresEntityStore,
  PostgresIdempotencyStore
} from "@/lib/persistence/postgres/authority-stores";
import { PostgresOrchestrationRunStore } from "@/lib/persistence/postgres/orchestration-store";

export class PostgresOwnerIntentStore implements OwnerIntentStore {
  private readonly orchestrations: PostgresOrchestrationRunStore;

  constructor(private readonly db: PostgresTransactionalDatabase) {
    this.orchestrations = new PostgresOrchestrationRunStore(db);
  }

  private fingerprint(record: OwnerIntentRecord) {
    return sha256Hex(JSON.stringify({
      portfolioId: record.portfolioId,
      companyId: record.companyId,
      userId: record.userId,
      message: record.message,
      channel: record.channel
    }));
  }

  private idempotencyRecordKey(record: OwnerIntentRecord, idempotencyKey: string) {
    return `owner-intent:${sha256Hex({
      portfolioId: record.portfolioId,
      companyId: record.companyId,
      idempotencyKey
    })}`;
  }

  private async ensureOrchestration(client: SqlQueryable, intent: OwnerIntentRecord) {
    const orchestration = createOwnerIntentOrchestrationRun(intent);
    await this.orchestrations.createInTransaction(
      client,
      orchestration,
      ownerIntentOrchestrationStartIdempotencyKey(intent.id)
    );
    return orchestration;
  }

  private async groundReadOnlyAnswer(record: OwnerIntentRecord) {
    const intent = record.conversation?.intent;
    if (!intent || !["status_query", "explain_query", "recommend_request"].includes(intent)) return record;
    const result = await this.db.query<{ entity_type: string; id: string; updated_at: string; payload: Record<string, unknown> }>(
      `SELECT entity_type,id,updated_at,payload
         FROM control_plane_entities
        WHERE portfolio_id=$1 AND company_id=$2
          AND entity_type = ANY($3::text[])
        ORDER BY updated_at DESC
        LIMIT 30`,
      [record.portfolioId, record.companyId, ["integration", "objective", "decision", "job", "outcome", "resource", "verification"]]
    );
    const names = record.conversation?.references.map((item) => item.name.toLowerCase()) ?? [];
    const relevant = names.length === 0
      ? result.rows
      : result.rows.filter((row) => {
          const haystack = JSON.stringify(row.payload).toLowerCase();
          return names.some((name) => haystack.includes(name));
        });
    const evidence = relevant.slice(0, 6);
    const summaries = evidence.map((row) => {
      const state = row.payload.state ?? row.payload.status ?? row.payload.health ?? "recorded";
      const label = row.payload.displayName ?? row.payload.title ?? row.payload.name ?? row.id;
      return `${row.entity_type} ${String(label)}: ${typeof state === "object" ? JSON.stringify(state) : String(state)}`;
    });
    const observedAt = evidence[0]?.updated_at
      ? new Date(evidence[0].updated_at).toISOString()
      : record.receivedAt;
    return Object.freeze({
      ...record,
      status: "answered" as const,
      answer: Object.freeze({
        text: summaries.length > 0
          ? summaries.join(". ")
          : "I don't have current authoritative evidence for that yet.",
        evidenceRefs: Object.freeze(evidence.map((row) => `${row.entity_type}:${row.id}`)),
        observedAt,
        knownUnknowns: Object.freeze(summaries.length > 0 ? [] : ["No matching current authoritative records"])
      })
    });
  }

  async create(record: OwnerIntentRecord, idempotencyKey: string) {
    let acceptedRecord = record;
    if (record.conversation?.continuation !== "none" && record.conversation?.continuation && record.conversation.references.length === 0) {
      const previous = await this.db.query<{ payload: OwnerIntentRecord }>(
        `SELECT payload FROM owner_intents
          WHERE portfolio_id=$1 AND company_id=$2 AND user_id=$3
          ORDER BY received_at DESC,id DESC LIMIT 1`,
        [record.portfolioId, record.companyId, record.userId]
      );
      const prior = previous.rows[0]?.payload;
      if (prior) {
        acceptedRecord = Object.freeze({
          ...record,
          continuesIntentId: prior.id,
          conversation: Object.freeze({
            ...record.conversation,
            references: Object.freeze([...(prior.conversation?.references ?? [])])
          })
        });
      }
    }
    acceptedRecord = await this.groundReadOnlyAnswer(acceptedRecord);
    const fingerprint = this.fingerprint(record);
    const idempotencyRecordKey = this.idempotencyRecordKey(record, idempotencyKey);

    return this.db.transaction(async (client) => {
      const idempotency = new PostgresIdempotencyStore(client);
      const claim = await claimIdempotency<OwnerIntentRecord>(
        idempotency,
        idempotencyRecordKey,
        fingerprint,
        new Date(record.receivedAt)
      );

      if (claim.state === "COMPLETED" && claim.record.result) {
        const persisted = claim.record.result;
        if (persisted.status === "accepted") await this.ensureOrchestration(client, persisted);
        return persisted;
      }
      if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
        throw new ControlPlaneError(
          "CONFLICT",
          "Owner intent request is already in progress or previously failed"
        );
      }

      const inserted = await client.query(
        `INSERT INTO owner_intents
          (id,portfolio_id,company_id,user_id,idempotency_key,received_at,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (portfolio_id,company_id,idempotency_key) DO NOTHING`,
        [
          acceptedRecord.id,
          acceptedRecord.portfolioId,
          acceptedRecord.companyId,
          acceptedRecord.userId,
          idempotencyKey,
          acceptedRecord.receivedAt,
          JSON.stringify(acceptedRecord)
        ]
      );

      let persisted = acceptedRecord;
      if (inserted.rowCount !== 1) {
        const existing = await client.query<{ payload: OwnerIntentRecord }>(
          `SELECT payload FROM owner_intents
           WHERE portfolio_id=$1 AND company_id=$2 AND idempotency_key=$3
           FOR UPDATE`,
          [record.portfolioId, record.companyId, idempotencyKey]
        );
        const prior = existing.rows[0]?.payload;
        if (
          !prior
          || prior.userId !== acceptedRecord.userId
          || prior.message !== acceptedRecord.message
          || prior.channel !== acceptedRecord.channel
        ) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Owner intent idempotency key conflicts with prior content"
          );
        }
        persisted = prior;
      }

      if (persisted.status === "accepted") await this.ensureOrchestration(client, persisted);

      await new PostgresAuditLedger(client).append(createAuditEvent({
        correlationId: persisted.correlationId ?? `owner-intent:${persisted.id}`,
        eventType: "owner-intent.accepted",
        actor: { type: "user", id: persisted.userId },
        scope: {
          userId: persisted.userId,
          portfolioId: persisted.portfolioId,
          companyId: persisted.companyId
        },
        environment: persisted.environment,
        entityType: "owner-intent",
        entityId: persisted.id,
        newState: persisted.status,
        provenance: "control-api:owner-intent",
        metadata: {
          idempotencyKey,
          orchestrationRunId: persisted.status === "accepted" ? createOwnerIntentOrchestrationRun(persisted).id : null
        }
      }));

      await idempotency.complete(
        idempotencyRecordKey,
        fingerprint,
        persisted,
        persisted.receivedAt
      );

      return persisted;
    });
  }

  async get(id: string): Promise<OwnerIntentRecord | null> {
    const result = await this.db.query<{ payload: OwnerIntentRecord }>(
      "SELECT payload FROM owner_intents WHERE id=$1",
      [id]
    );
    return result.rows[0]?.payload ?? null;
  }
}


export class PostgresObjectiveIntakeStore implements ObjectiveIntakeStore {
  constructor(private readonly db: PostgresTransactionalDatabase) {}

  async createBatch(records: readonly ObjectiveRecord[], idempotencyKey: string) {
    if (records.length === 0) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Objective batch cannot be empty");
    }

    const fingerprint = sha256Hex(JSON.stringify(records.map((record) => ({
      portfolioId: record.portfolioId,
      companyId: record.companyId,
      environment: record.environment,
      createdByUserId: record.createdByUserId,
      source: record.source,
      rawText: record.rawText,
      normalizedGoal: record.normalizedGoal,
      desiredOutcome: record.desiredOutcome,
      constraints: record.constraints,
      priority: record.priority,
      deadline: record.deadline ?? null,
      successCriteria: record.successCriteria,
      riskLevel: record.riskLevel,
      relationship: record.relationship,
      parentIndex: record.parentObjectiveId ? records.findIndex((item) => item.id === record.parentObjectiveId) : null,
      dependencyIndexes: record.dependsOnObjectiveIds.map((id) => records.findIndex((item) => item.id === id))
    }))));

    return this.db.transaction(async (client) => {
      const idempotency = new PostgresIdempotencyStore(client);
      const claim = await claimIdempotency<readonly ObjectiveRecord[]>(
        idempotency,
        idempotencyKey,
        fingerprint,
        new Date(records[0].createdAt)
      );

      if (claim.state === "COMPLETED" && claim.record.result) {
        return claim.record.result;
      }
      if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
        throw new ControlPlaneError(
          "CONFLICT",
          "Objective intake request is already in progress or previously failed"
        );
      }

      const objectives = new PostgresEntityStore<ObjectiveRecord>(client, "objective");
      const audit = new PostgresAuditLedger(client);
      for (const record of records) {
        await objectives.insert(record);
        await audit.append(createAuditEvent({
          correlationId: record.correlationId ?? `objective:${record.id}`,
          eventType: "objective.created",
          actor: { type: "user", id: record.createdByUserId },
          scope: {
            userId: record.createdByUserId,
            portfolioId: record.portfolioId,
            companyId: record.companyId
          },
          environment: record.environment,
          entityType: "objective",
          entityId: record.id,
          newState: record.status,
          provenance: "control-api:objective-intake",
          metadata: {
            idempotencyKey,
            source: record.source,
            relationship: record.relationship,
            parentObjectiveId: record.parentObjectiveId ?? null,
            dependencyCount: record.dependsOnObjectiveIds.length
          }
        }));
      }

      await idempotency.complete(
        idempotencyKey,
        fingerprint,
        records,
        records[0].createdAt
      );
      return records;
    });
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
