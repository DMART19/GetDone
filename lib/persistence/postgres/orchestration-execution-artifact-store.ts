import type { QueryResultRow } from "pg";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { createAuditEvent } from "@/lib/domain/audit";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import type { OrchestrationExecutionArtifactStore } from "@/lib/orchestration/execution-artifact-store";
import {
  assertExecutionArtifactIntegrity,
  type AuthorizationBundleExecutionArtifact,
  type JobBatchExecutionArtifact,
  type OrchestrationExecutionArtifact,
  type OrchestrationExecutionArtifactKind,
  type TaskDagExecutionArtifact,
  type ValidationReceiptExecutionArtifact
} from "@/lib/orchestration/execution-artifacts";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";
import { PostgresAuditLedger } from "@/lib/persistence/postgres/authority-stores";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

interface ArtifactRow extends QueryResultRow {
  id: string;
  run_id: string;
  correlation_id: string;
  portfolio_id: string;
  company_id: string;
  artifact_kind: OrchestrationExecutionArtifactKind;
  artifact_hash: string;
  predecessor_hash: string | null;
  created_at: Date | string;
  payload: OrchestrationExecutionArtifact;
}

function artifactHash(artifact: OrchestrationExecutionArtifact) {
  return artifact.value.artifactHash;
}

function artifactId(artifact: OrchestrationExecutionArtifact) {
  return artifact.value.id;
}

function predecessorHash(artifact: OrchestrationExecutionArtifact) {
  switch (artifact.kind) {
    case "validation-receipt":
      return artifact.value.receipt.validatorAttestationHash;
    case "authorization-bundle":
      return artifact.value.validationReceiptHash;
    case "task-dag":
      return artifact.value.authorizationBundleId;
    case "job-batch":
      return artifact.value.taskDagArtifactId;
  }
}

function assertScope(run: OrchestrationRun, artifact: OrchestrationExecutionArtifact) {
  assertExecutionArtifactIntegrity(artifact);
  if (
    artifact.value.runId !== run.id
    || artifact.value.correlationId !== run.correlationId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Execution artifact does not belong to orchestration run"
    );
  }
}

function assertStored(row: ArtifactRow) {
  const artifact = row.payload;
  if (
    artifact.kind !== row.artifact_kind
    || artifact.value.id !== row.id
    || artifact.value.runId !== row.run_id
    || artifact.value.correlationId !== row.correlation_id
    || artifact.value.artifactHash !== row.artifact_hash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Stored execution artifact metadata drifted"
    );
  }
  assertExecutionArtifactIntegrity(artifact);
  return artifact;
}

export class PostgresOrchestrationExecutionArtifactStore
implements OrchestrationExecutionArtifactStore {
  constructor(private readonly db: PostgresTransactionalDatabase) {}

  async append(run: OrchestrationRun, artifact: OrchestrationExecutionArtifact) {
    assertScope(run, artifact);

    return runWithPostgresTenantScope(
      { portfolioId: run.portfolioId, companyId: run.companyId },
      () => this.db.transaction(async (client) => {
        const inserted = await client.query<ArtifactRow>(
          `INSERT INTO orchestration_execution_artifacts (
             id,run_id,correlation_id,portfolio_id,company_id,
             artifact_kind,artifact_hash,predecessor_hash,created_at,payload
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [
            artifact.value.id,
            run.id,
            run.correlationId,
            run.portfolioId,
            run.companyId,
            artifact.kind,
            artifact.value.artifactHash,
            predecessorHash(artifact),
            artifact.value.createdAt,
            JSON.stringify(artifact)
          ]
        );

        if (inserted.rowCount === 1) {
          await new PostgresAuditLedger(client).append(createAuditEvent({
            correlationId: run.correlationId,
            eventType: "orchestration.execution-artifact-created",
            actor: { type: "system", id: "orchestration" },
            scope: {
              userId: run.authorityUserId,
              portfolioId: run.portfolioId,
              companyId: run.companyId
            },
            environment: run.environment,
            entityType: "orchestration-execution-artifact",
            entityId: artifact.value.id,
            newState: artifact.kind,
            provenance: "orchestration:execution-artifact-store",
            metadata: {
              artifactKind: artifact.kind,
              artifactHash: artifact.value.artifactHash,
              runId: run.id
            }
          }));
          return { created: true };
        }

        const existing = await client.query<ArtifactRow>(
          `SELECT * FROM orchestration_execution_artifacts
           WHERE run_id=$1
             AND (id=$2 OR (artifact_kind=$3 AND artifact_hash=$4))
           ORDER BY CASE WHEN id=$2 THEN 0 ELSE 1 END
           LIMIT 1`,
          [
            run.id,
            artifact.value.id,
            artifact.kind,
            artifact.value.artifactHash
          ]
        );
        const row = existing.rows[0];
        if (!row) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Execution artifact insert could not be reconstructed"
          );
        }
        const persisted = assertStored(row);
        if (
          persisted.kind !== artifact.kind
          || persisted.value.id !== artifact.value.id
          || persisted.value.artifactHash !== artifact.value.artifactHash
        ) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Execution artifact id already exists with different content"
          );
        }
        return { created: false };
      })
    );
  }

  private latest(
    run: OrchestrationRun,
    kind: OrchestrationExecutionArtifactKind
  ): Promise<OrchestrationExecutionArtifact | null> {
    return runWithPostgresTenantScope(
      { portfolioId: run.portfolioId, companyId: run.companyId },
      () => this.db.transaction(async (client) => {
        const result = await client.query<ArtifactRow>(
          `SELECT * FROM orchestration_execution_artifacts
           WHERE run_id=$1 AND artifact_kind=$2
           ORDER BY created_at DESC,id DESC
           LIMIT 1`,
          [run.id, kind]
        );
        return result.rows[0] ? assertStored(result.rows[0]) : null;
      })
    );
  }

  async latestValidationReceipt(run: OrchestrationRun): Promise<ValidationReceiptExecutionArtifact | null> {
    const artifact = await this.latest(run, "validation-receipt");
    return artifact?.kind === "validation-receipt" ? artifact.value : null;
  }

  async latestAuthorizationBundle(run: OrchestrationRun): Promise<AuthorizationBundleExecutionArtifact | null> {
    const artifact = await this.latest(run, "authorization-bundle");
    return artifact?.kind === "authorization-bundle" ? artifact.value : null;
  }

  async latestTaskDag(run: OrchestrationRun): Promise<TaskDagExecutionArtifact | null> {
    const artifact = await this.latest(run, "task-dag");
    return artifact?.kind === "task-dag" ? artifact.value : null;
  }

  async latestJobBatch(run: OrchestrationRun): Promise<JobBatchExecutionArtifact | null> {
    const artifact = await this.latest(run, "job-batch");
    return artifact?.kind === "job-batch" ? artifact.value : null;
  }

  async count(run: OrchestrationRun, kind: OrchestrationExecutionArtifactKind) {
    return runWithPostgresTenantScope(
      { portfolioId: run.portfolioId, companyId: run.companyId },
      () => this.db.transaction(async (client) => {
        const result = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM orchestration_execution_artifacts
           WHERE run_id=$1 AND artifact_kind=$2`,
          [run.id, kind]
        );
        return Number(result.rows[0]?.count ?? 0);
      })
    );
  }
}
