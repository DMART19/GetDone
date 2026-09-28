import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  ObjectiveProgressItem,
  ObjectiveRecord,
  ObjectiveStatus
} from "@/lib/domain/objective-inbox";
import type {
  OrchestrationCheckpoints,
  OrchestrationRunRecord,
  OrchestrationRunStore,
  OrchestrationRunStoreDescriptor,
  OrchestrationState
} from "@/lib/orchestration/contracts";
import {
  assertOrchestrationRunIntegrity,
  canTransitionOrchestration,
  isOrchestrationWorkerResumable
} from "@/lib/orchestration/contracts";
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";

export const POSTGRES_ORCHESTRATION_STORE_VERSION = "1.0.0";

const DEFAULT_RESUMABLE_STATES = Object.freeze<readonly OrchestrationState[]>([
  "accepted",
  "context-ready",
  "planning",
  "planned",
  "validated",
  "policy-evaluated",
  "awaiting-decision",
  "authorized",
  "tasks-created",
  "jobs-enqueued",
  "executing",
  "verifying"
]);

export interface OrchestrationTransitionReceipt {
  id: string;
  runId: string;
  portfolioId: string;
  companyId: string;
  idempotencyKey: string;
  fromState: OrchestrationState;
  toState: OrchestrationState;
  expectedVersion: number;
  nextVersion: number;
  expectedRecordHash: string;
  nextRecordHash: string;
  checkpointHash: string;
  occurredAt: string;
  result: OrchestrationRunRecord;
  transitionHash: string;
}

function requireKey(value: string, label: string) {
  if (!value.trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} is required`);
  }
  return value;
}

function checkpointHash(checkpoints: OrchestrationCheckpoints) {
  return sha256Hex(checkpoints);
}

function objectiveStatusForRun(state: OrchestrationState): ObjectiveStatus {
  switch (state) {
    case "accepted":
      return "queued";
    case "context-ready":
    case "planning":
    case "planned":
    case "validated":
    case "policy-evaluated":
      return "planning";
    case "awaiting-decision":
      return "needs_owner_input";
    case "authorized":
    case "tasks-created":
    case "jobs-enqueued":
    case "executing":
    case "verifying":
      return "executing";
    case "completed":
      return "completed";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

const POST_AUTHORIZATION_STATES = new Set<OrchestrationState>([
  "authorized",
  "tasks-created",
  "jobs-enqueued",
  "executing",
  "verifying",
  "completed"
]);

function objectiveProgressForRun(
  run: OrchestrationRunRecord
): readonly ObjectiveProgressItem[] {
  const items: ObjectiveProgressItem[] = [{
    label: "Objective accepted",
    status: "done",
    occurredAt: run.createdAt
  }];

  const planningStates = new Set<OrchestrationState>([
    "context-ready",
    "planning",
    "planned",
    "validated",
    "policy-evaluated"
  ]);
  if (planningStates.has(run.state)) {
    items.push({
      label: "Planning, validation, and policy checks",
      status: "running",
      occurredAt: run.updatedAt
    });
  } else if (
    run.state !== "accepted"
    && !["blocked", "failed", "cancelled"].includes(run.state)
  ) {
    items.push({
      label: "Planning, validation, and policy checks",
      status: "done",
      occurredAt: run.updatedAt
    });
  }

  if (run.checkpoints.decisionIds.length > 0) {
    items.push({
      label: "Owner decision",
      status: run.state === "awaiting-decision" ? "waiting" : "done",
      occurredAt: run.updatedAt
    });
  }

  if (
    ["authorized", "tasks-created", "jobs-enqueued", "executing"].includes(run.state)
  ) {
    items.push({
      label: "Executing authorized work",
      status: "running",
      occurredAt: run.updatedAt
    });
  } else if (run.state === "verifying" || run.state === "completed") {
    items.push({
      label: "Executing authorized work",
      status: "done",
      occurredAt: run.updatedAt
    });
  }

  if (run.state === "verifying") {
    items.push({
      label: "Verifying real-world outcome",
      status: "running",
      occurredAt: run.updatedAt
    });
  } else if (run.state === "completed") {
    items.push({
      label: "Verified objective outcome",
      status: "done",
      verified: true,
      occurredAt: run.updatedAt
    });
  } else if (run.state === "blocked" || run.state === "failed" || run.state === "cancelled") {
    items.push({
      label: run.state === "blocked"
        ? "Objective blocked"
        : run.state === "failed"
          ? "Objective failed"
          : "Objective cancelled",
      status: "failed",
      occurredAt: run.updatedAt
    });
  } else if (POST_AUTHORIZATION_STATES.has(run.state)) {
    // Kept explicit so future post-authorization states cannot silently omit
    // owner-facing execution progress.
  }

  return Object.freeze(items);
}

async function projectObjectiveRun(
  client: SqlQueryable,
  run: OrchestrationRunRecord
) {
  if (run.source.type !== "objective") return;

  const selected = await client.query<{ payload: ObjectiveRecord }>(
    `SELECT payload
       FROM control_plane_entities
      WHERE entity_type='objective' AND id=$1
      FOR UPDATE`,
    [run.source.id]
  );
  const objective = selected.rows[0]?.payload;
  if (!objective) {
    throw new ControlPlaneError(
      "NOT_FOUND",
      "Objective orchestration projection references a missing Objective",
      { correlationId: run.correlationId }
    );
  }
  if (
    objective.portfolioId !== run.scope.portfolioId
    || objective.companyId !== run.scope.companyId
    || objective.environment !== run.scope.environment
    || objective.createdByUserId !== run.scope.userId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Objective orchestration projection crossed authoritative scope",
      { correlationId: run.correlationId }
    );
  }

  const status = objectiveStatusForRun(run.state);
  const next: ObjectiveRecord = Object.freeze({
    ...objective,
    status,
    progress: objectiveProgressForRun(run),
    completedAt: status === "completed"
      ? (objective.completedAt ?? run.updatedAt)
      : undefined,
    updatedAt: run.updatedAt,
    version: objective.version + 1
  });

  const updated = await client.query(
    `UPDATE control_plane_entities
        SET version=$3, updated_at=$4, payload=$5::jsonb
      WHERE entity_type='objective' AND id=$1 AND version=$2`,
    [
      objective.id,
      objective.version,
      next.version,
      next.updatedAt,
      JSON.stringify(next)
    ]
  );
  if (updated.rowCount !== 1) {
    throw new ControlPlaneError(
      "CONFLICT",
      "Objective changed before orchestration projection commit",
      { correlationId: run.correlationId }
    );
  }
}

function transitionId(runId: string, version: number) {
  return `orchestration-transition:${runId}:v${version}`;
}

function checkpointId(runId: string, version: number) {
  return `orchestration-checkpoint:${runId}:v${version}`;
}

function receiptBase(input: {
  current: OrchestrationRunRecord;
  next: OrchestrationRunRecord;
  idempotencyKey: string;
}) {
  return {
    id: transitionId(input.next.id, input.next.version),
    runId: input.next.id,
    portfolioId: input.next.scope.portfolioId,
    companyId: input.next.scope.companyId,
    idempotencyKey: input.idempotencyKey,
    fromState: input.current.state,
    toState: input.next.state,
    expectedVersion: input.current.version,
    nextVersion: input.next.version,
    expectedRecordHash: input.current.recordHash,
    nextRecordHash: input.next.recordHash,
    checkpointHash: checkpointHash(input.next.checkpoints),
    occurredAt: input.next.updatedAt,
    result: input.next
  };
}

export function createOrchestrationTransitionReceipt(input: {
  current: OrchestrationRunRecord;
  next: OrchestrationRunRecord;
  idempotencyKey: string;
}): OrchestrationTransitionReceipt {
  requireKey(input.idempotencyKey, "orchestration transition idempotency key");
  assertOrchestrationRunIntegrity(input.current);
  assertOrchestrationRunIntegrity(input.next);

  if (input.current.id !== input.next.id) {
    throw new ControlPlaneError("FORBIDDEN", "Orchestration CAS cannot change run identity");
  }
  if (
    input.current.correlationId !== input.next.correlationId
    || input.current.scope.portfolioId !== input.next.scope.portfolioId
    || input.current.scope.companyId !== input.next.scope.companyId
    || input.current.scope.userId !== input.next.scope.userId
    || input.current.scope.environment !== input.next.scope.environment
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Orchestration CAS cannot change correlation or trusted scope"
    );
  }
  if (input.next.version !== input.current.version + 1) {
    throw new ControlPlaneError(
      "CONFLICT",
      "Orchestration CAS must advance the version exactly once"
    );
  }

  if (!canTransitionOrchestration(input.current.state, input.next.state)) {
    throw new ControlPlaneError(
      "CONFLICT",
      `Invalid orchestration CAS transition: ${input.current.state} -> ${input.next.state}`
    );
  }

  const base = receiptBase(input);
  return Object.freeze({ ...base, transitionHash: sha256Hex(base) });
}

export function orchestrationTransitionIdempotencyKey(
  run: Pick<OrchestrationRunRecord, "id" | "version" | "state">,
  to: OrchestrationState
) {
  return `orchestration:${run.id}:v${run.version}:${run.state}->${to}`;
}

export const POSTGRES_ORCHESTRATION_STORE_DESCRIPTOR:
  OrchestrationRunStoreDescriptor = Object.freeze({
    persistence: "durable-external",
    compareAndSwap: true,
    uniqueCorrelationId: true,
    restartSafe: true,
    multiProcessSafe: true,
    productionEligible: true
  });

interface RunRow {
  payload: OrchestrationRunRecord;
  start_idempotency_key: string;
  record_hash: string;
}

interface ReceiptRow {
  payload: OrchestrationTransitionReceipt;
  expected_record_hash: string;
  next_record_hash: string;
}

export class PostgresOrchestrationRunStore implements OrchestrationRunStore {
  readonly descriptor = POSTGRES_ORCHESTRATION_STORE_DESCRIPTOR;

  constructor(private readonly db: PostgresTransactionalDatabase) {}

  private async insertCheckpoint(
    client: SqlQueryable,
    record: OrchestrationRunRecord
  ) {
    const hash = checkpointHash(record.checkpoints);
    try {
      await client.query(
        `INSERT INTO orchestration_checkpoints
          (id,run_id,portfolio_id,company_id,run_version,state,checkpoint_hash,payload,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
        [
          checkpointId(record.id, record.version),
          record.id,
          record.scope.portfolioId,
          record.scope.companyId,
          record.version,
          record.state,
          hash,
          JSON.stringify(record.checkpoints),
          record.updatedAt
        ]
      );
    } catch (error) {
      if (
        error
        && typeof error === "object"
        && "code" in error
        && (error as { code?: string }).code === "23505"
      ) {
        const existing = await client.query<{
          checkpoint_hash: string;
          payload: OrchestrationCheckpoints;
        }>(
          `SELECT checkpoint_hash,payload
           FROM orchestration_checkpoints
           WHERE run_id=$1 AND run_version=$2`,
          [record.id, record.version]
        );
        const prior = existing.rows[0];
        if (
          prior?.checkpoint_hash === hash
          && sha256Hex(prior.payload) === hash
        ) {
          return;
        }
        throw new ControlPlaneError(
          "IDEMPOTENCY_CONFLICT",
          "Orchestration checkpoint version already exists with different content"
        );
      }
      throw error;
    }
  }

  async create(record: OrchestrationRunRecord, idempotencyKey: string) {
    return this.db.transaction((client) =>
      this.createInTransaction(client, record, idempotencyKey)
    );
  }

  async createInTransaction(
    client: SqlQueryable,
    record: OrchestrationRunRecord,
    idempotencyKey: string
  ) {
    requireKey(idempotencyKey, "orchestration start idempotency key");
    assertOrchestrationRunIntegrity(record);

    if (record.state !== "accepted" || record.version !== 1) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "New orchestration runs must start at accepted version 1"
      );
    }

    const inserted = await client.query(
      `INSERT INTO orchestration_runs
        (
          id,correlation_id,portfolio_id,company_id,user_id,environment,
          source_type,source_id,source_hash,state,authority,version,attempt,
          start_idempotency_key,record_hash,checkpoints,payload,created_at,updated_at
        )
       VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19
       )
       ON CONFLICT DO NOTHING`,
      [
        record.id,
        record.correlationId,
        record.scope.portfolioId,
        record.scope.companyId,
        record.scope.userId,
        record.scope.environment,
        record.source.type,
        record.source.id,
        record.source.sourceHash,
        record.state,
        record.authority,
        record.version,
        record.attempt,
        idempotencyKey,
        record.recordHash,
        JSON.stringify(record.checkpoints),
        JSON.stringify(record),
        record.createdAt,
        record.updatedAt
      ]
    );

    if (inserted.rowCount === 1) {
      await this.insertCheckpoint(client, record);
      await client.query(
        `INSERT INTO orchestration_worker_state
          (
            run_id,portfolio_id,company_id,stage_run_version,stage_attempt,
            consecutive_failures,ready_at,lease_version,updated_at
          )
         VALUES($1,$2,$3,$4,0,0,$5,0,$5)`,
        [
          record.id,
          record.scope.portfolioId,
          record.scope.companyId,
          record.version,
          record.updatedAt
        ]
      );
      return { status: "created" as const, record };
    }

    const existing = await client.query<RunRow>(
      `SELECT payload,start_idempotency_key,record_hash
       FROM orchestration_runs
       WHERE portfolio_id=$1
         AND company_id=$2
         AND (
           start_idempotency_key=$3
           OR correlation_id=$4
           OR id=$5
         )
       FOR UPDATE`,
      [
        record.scope.portfolioId,
        record.scope.companyId,
        idempotencyKey,
        record.correlationId,
        record.id
      ]
    );

    const prior = existing.rows[0];
    if (
      prior
      && prior.start_idempotency_key === idempotencyKey
      && prior.record_hash === record.recordHash
      && prior.payload.correlationId === record.correlationId
    ) {
      assertOrchestrationRunIntegrity(prior.payload);
      return { status: "idempotent-replay" as const, record: prior.payload };
    }

    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Orchestration start conflicts with an existing run, correlation, or idempotency key",
      { correlationId: record.correlationId }
    );
  }

  async get(id: string): Promise<OrchestrationRunRecord | null> {
    const result = await this.db.query<{ payload: OrchestrationRunRecord }>(
      "SELECT payload FROM orchestration_runs WHERE id=$1",
      [id]
    );
    const record = result.rows[0]?.payload ?? null;
    if (record) assertOrchestrationRunIntegrity(record);
    return record;
  }

  async getByCorrelationId(
    correlationId: string
  ): Promise<OrchestrationRunRecord | null> {
    const result = await this.db.query<{ payload: OrchestrationRunRecord }>(
      "SELECT payload FROM orchestration_runs WHERE correlation_id=$1",
      [correlationId]
    );
    const record = result.rows[0]?.payload ?? null;
    if (record) assertOrchestrationRunIntegrity(record);
    return record;
  }

  async compareAndSwap(
    next: OrchestrationRunRecord,
    input: {
      expectedVersion: number;
      expectedRecordHash: string;
      idempotencyKey: string;
    }
  ) {
    requireKey(input.idempotencyKey, "orchestration transition idempotency key");
    assertOrchestrationRunIntegrity(next);

    if (next.version !== input.expectedVersion + 1) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Orchestration CAS next version must be expected version plus one",
        { correlationId: next.correlationId }
      );
    }

    return this.db.transaction(async (client) => {
      const priorReceipt = await client.query<ReceiptRow>(
        `SELECT payload,expected_record_hash,next_record_hash
         FROM orchestration_transition_receipts
         WHERE run_id=$1 AND idempotency_key=$2
         FOR UPDATE`,
        [next.id, input.idempotencyKey]
      );

      const replay = priorReceipt.rows[0];
      if (replay) {
        if (
          replay.expected_record_hash !== input.expectedRecordHash
          || replay.next_record_hash !== next.recordHash
          || replay.payload.transitionHash !== sha256Hex({
            ...replay.payload,
            transitionHash: undefined
          })
        ) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Orchestration transition idempotency key was reused with different content",
            { correlationId: next.correlationId }
          );
        }
        assertOrchestrationRunIntegrity(replay.payload.result);
        return replay.payload.result;
      }

      const currentResult = await client.query<{ payload: OrchestrationRunRecord }>(
        `SELECT payload
         FROM orchestration_runs
         WHERE id=$1
         FOR UPDATE`,
        [next.id]
      );
      const current = currentResult.rows[0]?.payload;
      if (!current) {
        throw new ControlPlaneError(
          "NOT_FOUND",
          "Orchestration run was not found",
          { correlationId: next.correlationId }
        );
      }
      assertOrchestrationRunIntegrity(current);

      if (
        current.version !== input.expectedVersion
        || current.recordHash !== input.expectedRecordHash
      ) {
        throw new ControlPlaneError(
          "CONFLICT",
          "Orchestration run changed before compare-and-swap persistence",
          {
            correlationId: next.correlationId,
            details: {
              expectedVersion: input.expectedVersion,
              actualVersion: current.version
            }
          }
        );
      }

      const receipt = createOrchestrationTransitionReceipt({
        current,
        next,
        idempotencyKey: input.idempotencyKey
      });

      const updated = await client.query(
        `UPDATE orchestration_runs
         SET
           state=$2,
           version=$3,
           attempt=$4,
           record_hash=$5,
           checkpoints=$6::jsonb,
           payload=$7::jsonb,
           updated_at=$8
         WHERE id=$1
           AND version=$9
           AND record_hash=$10`,
        [
          next.id,
          next.state,
          next.version,
          next.attempt,
          next.recordHash,
          JSON.stringify(next.checkpoints),
          JSON.stringify(next),
          next.updatedAt,
          input.expectedVersion,
          input.expectedRecordHash
        ]
      );

      if (updated.rowCount !== 1) {
        throw new ControlPlaneError(
          "CONFLICT",
          "Orchestration run changed during compare-and-swap persistence",
          { correlationId: next.correlationId }
        );
      }

      if (
        current.state === "awaiting-decision"
        && next.state !== "awaiting-decision"
      ) {
        await client.query(
          `UPDATE orchestration_decision_resume_requests
              SET status='processed', processed_at=$2
            WHERE run_id=$1 AND status='pending'`,
          [next.id, next.updatedAt]
        );
      }

      const resumable = isOrchestrationWorkerResumable(next);
      const queueProjection = await client.query(
        `UPDATE orchestration_worker_state
         SET
           run_state=$2,
           ready_at=CASE
             WHEN $3 THEN LEAST(ready_at,$4::timestamptz)
             ELSE ready_at
           END,
           updated_at=GREATEST(updated_at,$4::timestamptz)
         WHERE run_id=$1`,
        [next.id, next.state, resumable, next.updatedAt]
      );
      if (queueProjection.rowCount !== 1) {
        throw new ControlPlaneError(
          "CONFLICT",
          "Orchestration queue projection is missing for authoritative run",
          { correlationId: next.correlationId }
        );
      }

      await this.insertCheckpoint(client, next);
      await projectObjectiveRun(client, next);

      await client.query(
        `INSERT INTO orchestration_transition_receipts
          (
            id,run_id,portfolio_id,company_id,idempotency_key,from_state,to_state,
            expected_version,next_version,expected_record_hash,next_record_hash,
            checkpoint_hash,occurred_at,payload
          )
         VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb
         )`,
        [
          receipt.id,
          receipt.runId,
          receipt.portfolioId,
          receipt.companyId,
          receipt.idempotencyKey,
          receipt.fromState,
          receipt.toState,
          receipt.expectedVersion,
          receipt.nextVersion,
          receipt.expectedRecordHash,
          receipt.nextRecordHash,
          receipt.checkpointHash,
          receipt.occurredAt,
          JSON.stringify(receipt)
        ]
      );

      return next;
    });
  }

  async listResumable(input: {
    limit: number;
    states?: readonly OrchestrationState[];
  }): Promise<readonly OrchestrationRunRecord[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Orchestration recovery limit must be an integer from 1 to 500"
      );
    }

    const states = input.states?.length
      ? [...new Set(input.states)]
      : [...DEFAULT_RESUMABLE_STATES];

    const result = await this.db.query<{ payload: OrchestrationRunRecord }>(
      `SELECT run.payload
       FROM orchestration_runs run
       WHERE run.state = ANY($1::text[])
         AND (
           run.state <> 'awaiting-decision'
           OR EXISTS (
             SELECT 1
             FROM orchestration_decision_resume_requests resume
             WHERE resume.run_id=run.id
               AND resume.status='pending'
           )
         )
       ORDER BY run.updated_at,run.id
       LIMIT $2`,
      [states, input.limit]
    );

    const records = result.rows.map((row) => {
      assertOrchestrationRunIntegrity(row.payload);
      if (!isOrchestrationWorkerResumable(row.payload)) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "PostgreSQL resumable query returned a non-resumable orchestration state"
        );
      }
      return row.payload;
    });

    return Object.freeze(records);
  }
}
