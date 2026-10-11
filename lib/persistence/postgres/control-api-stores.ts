import type { ContextItem } from "@/lib/intelligence/context";
import { groundConversationAnswer } from "@/lib/conversation/answers";
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
      channel: record.channel,
      threadId: record.threadId
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
    if (!intent || !["status_query", "explain_query", "recommend_request", "investigate_request"].includes(intent)
      || record.conversation?.requiresExecutionAuthority) return record;
    // Only presentation fields from authorized, fresh records become answer evidence.
    const result = await this.db.query<{ id: string; entity_type: string; updated_at: string; title: string; state: string; sensitivity: ContextItem["sensitivity"] }>(
      `SELECT id,entity_type,updated_at,
        COALESCE(payload->>'displayName',payload->>'title',payload->>'normalizedGoal',id) AS title,
        COALESCE(payload->>'state',payload->>'status','recorded') AS state,
        LOWER(COALESCE(payload->>'sensitivity',payload->>'dataClass',payload->'scope'->>'dataClass','internal')) AS sensitivity
       FROM control_plane_entities
       WHERE portfolio_id=$1 AND company_id=$2
         AND entity_type = ANY($3::text[])
         AND (payload->>'environment'=$4 OR (entity_type IN ('decision','job','outcome','verification') AND NOT payload ? 'environment'))
         AND updated_at >= $5::timestamptz - interval '7 days'
       ORDER BY updated_at DESC,id LIMIT 500`,
      [record.portfolioId, record.companyId, ["fact", "signal", "integration", "objective", "decision", "job", "outcome", "verification"], record.environment, record.receivedAt]
    );
    return groundConversationAnswer(record, result.rows);
  }

  async create(record: OwnerIntentRecord, idempotencyKey: string) {
    let acceptedRecord = record;
    if (record.conversation?.continuation && record.conversation.continuation !== "none" && record.status !== "answered") {
      const selected = record.conversationState?.selectedAction;
      if (selected) {
        acceptedRecord = { ...record, continuesIntentId: selected.sourceIntentId };
      } else {
        acceptedRecord = { ...record, status: "answered", answer: {
          text: "Which proposed action should I prepare? Please specify its scope.", evidenceRefs: [],
          observedAt: record.receivedAt, knownUnknowns: ["No unambiguous selected action"]
        } };
      }
    }
    acceptedRecord = acceptedRecord.status === "answered"
      ? acceptedRecord
      : await this.groundReadOnlyAnswer(acceptedRecord);
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
          || prior.threadId !== acceptedRecord.threadId
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
        eventType: persisted.status === "answered" ? "owner-intent.answered" : "owner-intent.accepted",
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

  async listConversation(portfolioId: string, companyId: string, userId: string, environment: string, threadId?: string): Promise<OwnerIntentRecord[]> {
    const result = await this.db.query<{ payload: OwnerIntentRecord }>(
      `SELECT payload FROM owner_intents WHERE portfolio_id=$1 AND company_id=$2 AND user_id=$3
        AND payload->>'environment'=$4 AND payload ? 'threadId'
        AND ($5::text IS NULL OR payload->>'threadId'=$5)
       ORDER BY received_at DESC,id DESC LIMIT 100`, [portfolioId, companyId, userId, environment, threadId ?? null]);
    return result.rows.map(row => row.payload);
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
