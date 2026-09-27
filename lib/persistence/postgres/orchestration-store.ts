import { ControlPlaneError } from "@/lib/control-plane/errors";
import { createAuditEvent } from "@/lib/domain/audit";
import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import {
  assertOrchestrationTransition,
  isTerminalOrchestrationState,
  orchestrationResumeEventId,
  orchestrationRunId,
  orchestrationSourceIdentity,
  orchestrationTriggerEventId,
  type ClaimedOrchestrationRun,
  type OrchestrationQueueEvent,
  type OrchestrationRun,
  type OrchestrationRunState,
  type OrchestrationSource
} from "@/lib/orchestration/contracts";
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";
import { PostgresAuditLedger } from "@/lib/persistence/postgres/authority-stores";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

interface OrchestrationRunRow {
  id: string;
  correlation_id: string;
  portfolio_id: string;
  company_id: string;
  environment: OrchestrationRun["environment"];
  authority_user_id: string;
  initiating_actor_type: OrchestrationRun["initiatingActor"]["type"];
  initiating_actor_id: string;
  source_kind: OrchestrationSource["kind"];
  source_id: string;
  source_payload: unknown;
  state: OrchestrationRunState;
  attempt: number;
  version: number;
  available_at: Date | string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface OrchestrationQueueRow {
  id: string;
  correlation_id: string;
  portfolio_id: string;
  company_id: string;
  event_type: OrchestrationQueueEvent["eventType"];
  run_id: string;
  occurred_at: Date | string;
  available_at: Date | string;
  claimed_by: string | null;
  claimed_until: Date | string | null;
  delivered_at: Date | string | null;
  attempts: number;
  last_error: string | null;
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalIso(value: Date | string | null) {
  return value === null ? undefined : iso(value);
}

function parseSource(row: OrchestrationRunRow): OrchestrationSource {
  const payload = row.source_payload && typeof row.source_payload === "object"
    ? row.source_payload as Record<string, unknown>
    : {};

  if (row.source_kind === "owner-intent") {
    return Object.freeze({ kind: row.source_kind, ownerIntentId: row.source_id });
  }
  if (row.source_kind === "objective") {
    return Object.freeze({ kind: row.source_kind, objectiveId: row.source_id });
  }
  if (row.source_kind === "investigation") {
    const signalIds = Array.isArray(payload.signalIds)
      ? payload.signalIds.filter((item): item is string => typeof item === "string")
      : [];
    return Object.freeze({
      kind: row.source_kind,
      investigationId: row.source_id,
      signalIds: Object.freeze(signalIds)
    });
  }
  throw new ControlPlaneError("VALIDATION_FAILED", "Unknown orchestration source kind");
}

function mapRun(row: OrchestrationRunRow): OrchestrationRun {
  return Object.freeze({
    id: row.id,
    correlationId: row.correlation_id,
    portfolioId: row.portfolio_id,
    companyId: row.company_id,
    environment: row.environment,
    authorityUserId: row.authority_user_id,
    initiatingActor: Object.freeze({
      type: row.initiating_actor_type,
      id: row.initiating_actor_id
    }),
    source: parseSource(row),
    state: row.state,
    attempt: row.attempt,
    version: row.version,
    availableAt: iso(row.available_at),
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: optionalIso(row.lease_expires_at),
    lastErrorCode: row.last_error_code ?? undefined,
    lastErrorMessage: row.last_error_message ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  });
}

function mapQueueEvent(row: OrchestrationQueueRow): OrchestrationQueueEvent {
  return Object.freeze({
    id: row.id,
    correlationId: row.correlation_id,
    portfolioId: row.portfolio_id,
    companyId: row.company_id,
    eventType: row.event_type,
    runId: row.run_id,
    occurredAt: iso(row.occurred_at),
    availableAt: iso(row.available_at),
    claimedBy: row.claimed_by ?? undefined,
    claimedUntil: optionalIso(row.claimed_until),
    deliveredAt: optionalIso(row.delivered_at),
    attempts: row.attempts,
    lastError: row.last_error ?? undefined
  });
}

function boundedReason(value: string) {
  const normalized = value.trim();
  if (!normalized) return "unspecified";
  return normalized.slice(0, 1_000);
}

function assertWorkerId(workerId: string) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(workerId)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Orchestration worker id is invalid");
  }
}

function assertPositiveLease(leaseMilliseconds: number) {
  if (!Number.isInteger(leaseMilliseconds) || leaseMilliseconds < 1_000 || leaseMilliseconds > 300_000) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Orchestration lease must be between 1 and 300 seconds"
    );
  }
}

export function buildOwnerIntentOrchestrationRun(
  record: OwnerIntentRecord
): OrchestrationRun {
  const source: OrchestrationSource = Object.freeze({
    kind: "owner-intent",
    ownerIntentId: record.id
  });
  const correlationId = record.correlationId ?? `legacy-owner-intent:${record.id}`;
  return Object.freeze({
    id: orchestrationRunId(source),
    correlationId,
    portfolioId: record.portfolioId,
    companyId: record.companyId,
    environment: record.environment,
    authorityUserId: record.userId,
    initiatingActor: Object.freeze({ type: "user" as const, id: record.userId }),
    source,
    state: "received" as const,
    attempt: 1,
    version: 1,
    availableAt: record.receivedAt,
    createdAt: record.receivedAt,
    updatedAt: record.receivedAt
  });
}

export async function persistOwnerIntentOrchestrationTrigger(
  db: SqlQueryable,
  record: OwnerIntentRecord
) {
  const run = buildOwnerIntentOrchestrationRun(record);
  const identity = orchestrationSourceIdentity(run.source);

  const inserted = await db.query<OrchestrationRunRow>(
    `INSERT INTO orchestration_runs (
       id,correlation_id,portfolio_id,company_id,environment,
       authority_user_id,initiating_actor_type,initiating_actor_id,
       source_kind,source_id,source_payload,state,attempt,version,
       available_at,created_at,updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17
     )
     ON CONFLICT (portfolio_id,company_id,source_kind,source_id) DO NOTHING
     RETURNING *`,
    [
      run.id,
      run.correlationId,
      run.portfolioId,
      run.companyId,
      run.environment,
      run.authorityUserId,
      run.initiatingActor.type,
      run.initiatingActor.id,
      identity.kind,
      identity.id,
      JSON.stringify(run.source),
      run.state,
      run.attempt,
      run.version,
      run.availableAt,
      run.createdAt,
      run.updatedAt
    ]
  );

  let persisted = inserted.rows[0] ? mapRun(inserted.rows[0]) : null;
  const created = Boolean(persisted);

  if (!persisted) {
    const existing = await db.query<OrchestrationRunRow>(
      `SELECT * FROM orchestration_runs
       WHERE portfolio_id=$1 AND company_id=$2 AND source_kind=$3 AND source_id=$4`,
      [run.portfolioId, run.companyId, identity.kind, identity.id]
    );
    const prior = existing.rows[0];
    if (!prior) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "Owner intent orchestration run could not be persisted"
      );
    }
    persisted = mapRun(prior);
    if (
      persisted.correlationId !== run.correlationId
      || persisted.environment !== run.environment
      || persisted.authorityUserId !== run.authorityUserId
    ) {
      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "Owner intent already maps to a different orchestration authority envelope"
      );
    }
  }

  const eventId = orchestrationTriggerEventId(persisted.id);
  await db.query(
    `INSERT INTO orchestration_outbox (
       id,correlation_id,portfolio_id,company_id,event_type,run_id,
       occurred_at,available_at,attempts
     ) VALUES ($1,$2,$3,$4,'orchestration.triggered',$5,$6,$6,0)
     ON CONFLICT (id) DO NOTHING`,
    [
      eventId,
      persisted.correlationId,
      persisted.portfolioId,
      persisted.companyId,
      persisted.id,
      persisted.createdAt
    ]
  );

  return Object.freeze({ run: persisted, created, eventId });
}

export class PostgresOrchestrationRuntimeStore {
  constructor(private readonly db: PostgresTransactionalDatabase) {}

  private async releaseQueueClaim(
    eventId: string,
    workerId: string,
    availableAt: string,
    reason?: string
  ) {
    await this.db.query(
      `UPDATE orchestration_outbox
       SET claimed_by=NULL,claimed_until=NULL,available_at=$3,last_error=$4
       WHERE id=$1 AND delivered_at IS NULL AND claimed_by=$2`,
      [eventId, workerId, availableAt, reason ? boundedReason(reason) : null]
    );
  }

  private async markQueueDelivered(eventId: string, workerId: string, deliveredAt: string) {
    const result = await this.db.query(
      `UPDATE orchestration_outbox
       SET delivered_at=$3,claimed_by=NULL,claimed_until=NULL,last_error=NULL
       WHERE id=$1 AND delivered_at IS NULL AND claimed_by=$2`,
      [eventId, workerId, deliveredAt]
    );
    if (result.rowCount !== 1) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Orchestration queue delivery lost the authoritative queue claim"
      );
    }
  }

  async claimNext(input: {
    workerId: string;
    leaseMilliseconds: number;
    now: string;
  }): Promise<ClaimedOrchestrationRun | null> {
    assertWorkerId(input.workerId);
    assertPositiveLease(input.leaseMilliseconds);
    const nowMs = Date.parse(input.now);
    if (!Number.isFinite(nowMs)) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Orchestration claim time is invalid");
    }
    const claimedUntil = new Date(nowMs + input.leaseMilliseconds).toISOString();

    const event = await this.db.transaction(async (client) => {
      const candidate = await client.query<OrchestrationQueueRow>(
        `SELECT * FROM orchestration_outbox
         WHERE delivered_at IS NULL
           AND event_type IN ('orchestration.triggered','orchestration.resume')
           AND available_at <= $1
           AND (claimed_until IS NULL OR claimed_until <= $1)
         ORDER BY available_at,occurred_at,id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [input.now]
      );
      const row = candidate.rows[0];
      if (!row) return null;

      const updated = await client.query<OrchestrationQueueRow>(
        `UPDATE orchestration_outbox
         SET claimed_by=$2,claimed_until=$3,attempts=attempts+1,last_error=NULL
         WHERE id=$1
         RETURNING *`,
        [row.id, input.workerId, claimedUntil]
      );
      return updated.rows[0] ? mapQueueEvent(updated.rows[0]) : null;
    });

    if (!event) return null;

    try {
      const claimResult = await runWithPostgresTenantScope(
        { portfolioId: event.portfolioId, companyId: event.companyId },
        () => this.db.transaction(async (client) => {
          const result = await client.query<OrchestrationRunRow>(
            `SELECT * FROM orchestration_runs
             WHERE id=$1 AND portfolio_id=$2 AND company_id=$3
             FOR UPDATE`,
            [event.runId, event.portfolioId, event.companyId]
          );
          const row = result.rows[0];
          if (!row) {
            throw new ControlPlaneError(
              "NOT_FOUND",
              "Orchestration queue event references a missing authoritative run"
            );
          }
          const current = mapRun(row);
          if (isTerminalOrchestrationState(current.state)) {
            return Object.freeze({ kind: "terminal" as const, run: current });
          }
          if (Date.parse(current.availableAt) > nowMs) {
            return Object.freeze({
              kind: "not-ready" as const,
              availableAt: current.availableAt
            });
          }
          if (
            current.leaseExpiresAt
            && Date.parse(current.leaseExpiresAt) > nowMs
            && current.leaseOwner !== input.workerId
          ) {
            return Object.freeze({
              kind: "not-ready" as const,
              availableAt: current.leaseExpiresAt
            });
          }

          const leased = await client.query<OrchestrationRunRow>(
            `UPDATE orchestration_runs
             SET lease_owner=$2,lease_expires_at=$3
             WHERE id=$1 AND version=$4
             RETURNING *`,
            [current.id, input.workerId, claimedUntil, current.version]
          );
          const leasedRow = leased.rows[0];
          if (!leasedRow) {
            throw new ControlPlaneError(
              "CONFLICT",
              "Orchestration run lease lost optimistic concurrency"
            );
          }
          return Object.freeze({ kind: "claimed" as const, run: mapRun(leasedRow) });
        })
      );

      if (claimResult.kind === "not-ready") {
        await this.releaseQueueClaim(
          event.id,
          input.workerId,
          claimResult.availableAt
        );
        return null;
      }
      if (claimResult.kind === "terminal") {
        await this.markQueueDelivered(event.id, input.workerId, input.now);
        return null;
      }
      return Object.freeze({ event, run: claimResult.run });
    } catch (error) {
      await this.releaseQueueClaim(
        event.id,
        input.workerId,
        new Date(nowMs + Math.min(input.leaseMilliseconds, 30_000)).toISOString(),
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  async transition(input: {
    claim: ClaimedOrchestrationRun;
    workerId: string;
    nextState: OrchestrationRunState;
    availableAt: string;
    scheduleResume: boolean;
    reason?: string;
    now: string;
  }) {
    assertWorkerId(input.workerId);
    assertOrchestrationTransition(input.claim.run.state, input.nextState);

    return runWithPostgresTenantScope(
      {
        portfolioId: input.claim.run.portfolioId,
        companyId: input.claim.run.companyId
      },
      () => this.db.transaction(async (client) => {
        const currentResult = await client.query<OrchestrationRunRow>(
          `SELECT * FROM orchestration_runs
           WHERE id=$1 AND portfolio_id=$2 AND company_id=$3
           FOR UPDATE`,
          [
            input.claim.run.id,
            input.claim.run.portfolioId,
            input.claim.run.companyId
          ]
        );
        const currentRow = currentResult.rows[0];
        if (!currentRow) {
          throw new ControlPlaneError("NOT_FOUND", "Authoritative orchestration run was not found");
        }
        const current = mapRun(currentRow);
        if (
          current.version !== input.claim.run.version
          || current.state !== input.claim.run.state
        ) {
          throw new ControlPlaneError(
            "CONFLICT",
            "Orchestration run changed after it was claimed"
          );
        }
        if (current.leaseOwner !== input.workerId) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Orchestration transition requires the authoritative worker lease"
          );
        }
        assertOrchestrationTransition(current.state, input.nextState);

        const nextVersion = current.version + 1;
        const updated = await client.query<OrchestrationRunRow>(
          `UPDATE orchestration_runs
           SET state=$2,version=$3,available_at=$4,
               lease_owner=NULL,lease_expires_at=NULL,
               last_error_code=NULL,last_error_message=NULL,updated_at=$5
           WHERE id=$1 AND version=$6
           RETURNING *`,
          [
            current.id,
            input.nextState,
            nextVersion,
            input.availableAt,
            input.now,
            current.version
          ]
        );
        const nextRow = updated.rows[0];
        if (!nextRow) {
          throw new ControlPlaneError("CONFLICT", "Orchestration transition lost optimistic concurrency");
        }
        const next = mapRun(nextRow);

        const delivered = await client.query(
          `UPDATE orchestration_outbox
           SET delivered_at=$2,claimed_by=NULL,claimed_until=NULL,last_error=NULL
           WHERE id=$1 AND delivered_at IS NULL AND claimed_by=$3`,
          [input.claim.event.id, input.now, input.workerId]
        );
        if (delivered.rowCount !== 1) {
          throw new ControlPlaneError(
            "CONFLICT",
            "Orchestration queue claim is no longer authoritative"
          );
        }

        if (input.scheduleResume && !isTerminalOrchestrationState(next.state)) {
          const resumeId = orchestrationResumeEventId(next.id, next.version);
          await client.query(
            `INSERT INTO orchestration_outbox (
               id,correlation_id,portfolio_id,company_id,event_type,run_id,
               occurred_at,available_at,attempts
             ) VALUES ($1,$2,$3,$4,'orchestration.resume',$5,$6,$7,0)
             ON CONFLICT (id) DO NOTHING`,
            [
              resumeId,
              next.correlationId,
              next.portfolioId,
              next.companyId,
              next.id,
              input.now,
              input.availableAt
            ]
          );
        }

        await new PostgresAuditLedger(client).append(createAuditEvent({
          correlationId: next.correlationId,
          eventType: "orchestration.state-transitioned",
          actor: { type: "worker", id: input.workerId },
          scope: {
            userId: next.authorityUserId,
            portfolioId: next.portfolioId,
            companyId: next.companyId
          },
          environment: next.environment,
          entityType: "orchestration-run",
          entityId: next.id,
          previousState: current.state,
          newState: next.state,
          provenance: "orchestration:coordinator",
          metadata: {
            queueEventId: input.claim.event.id,
            runVersion: next.version,
            scheduleResume: input.scheduleResume,
            reason: input.reason ? boundedReason(input.reason) : null
          }
        }));

        return next;
      })
    );
  }

  async defer(input: {
    claim: ClaimedOrchestrationRun;
    workerId: string;
    retryAt: string;
    reason: string;
    now: string;
  }) {
    assertWorkerId(input.workerId);
    const reason = boundedReason(input.reason);

    await runWithPostgresTenantScope(
      {
        portfolioId: input.claim.run.portfolioId,
        companyId: input.claim.run.companyId
      },
      () => this.db.transaction(async (client) => {
        const released = await client.query(
          `UPDATE orchestration_runs
           SET available_at=$2,lease_owner=NULL,lease_expires_at=NULL,
               last_error_code='DEFERRED',last_error_message=$3,updated_at=$4
           WHERE id=$1 AND version=$5 AND lease_owner=$6`,
          [
            input.claim.run.id,
            input.retryAt,
            reason,
            input.now,
            input.claim.run.version,
            input.workerId
          ]
        );
        if (released.rowCount !== 1) {
          throw new ControlPlaneError(
            "CONFLICT",
            "Orchestration defer lost the authoritative worker lease"
          );
        }

        const eventReleased = await client.query(
          `UPDATE orchestration_outbox
           SET claimed_by=NULL,claimed_until=NULL,available_at=$2,last_error=$3
           WHERE id=$1 AND delivered_at IS NULL AND claimed_by=$4`,
          [input.claim.event.id, input.retryAt, reason, input.workerId]
        );
        if (eventReleased.rowCount !== 1) {
          throw new ControlPlaneError(
            "CONFLICT",
            "Orchestration queue defer lost the authoritative queue claim"
          );
        }
      })
    );
  }
}
