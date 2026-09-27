import { ControlPlaneError } from "@/lib/control-plane/errors";
import { createAuditEvent } from "@/lib/domain/audit";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import type { OrchestrationPlanningArtifactStore } from "@/lib/orchestration/planning-artifact-store";
import {
  assertContextSnapshotIntegrity,
  assertGovernedPlanArtifactIntegrity,
  assertPlanValidationArtifactIntegrity,
  assertPolicyBundleArtifactIntegrity,
  type GovernedPlanArtifact,
  type OrchestrationContextSnapshot,
  type OrchestrationPlanningArtifact,
  type OrchestrationPlanningArtifactKind,
  type PlanValidationArtifact,
  type PolicyBundleArtifact
} from "@/lib/orchestration/planning-artifacts";
import type { QueryResultRow } from "pg";
import type {
  PostgresTransactionalDatabase
} from "@/lib/persistence/postgres/client";
import { PostgresAuditLedger } from "@/lib/persistence/postgres/authority-stores";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

interface ArtifactRow extends QueryResultRow {
  id: string;
  run_id: string;
  correlation_id: string;
  portfolio_id: string;
  company_id: string;
  artifact_kind: OrchestrationPlanningArtifactKind;
  artifact_hash: string;
  predecessor_hash: string | null;
  created_at: Date | string;
  payload: OrchestrationPlanningArtifact;
}

function artifactHash(artifact: OrchestrationPlanningArtifact) {
  switch (artifact.kind) {
    case "context-snapshot": return artifact.value.contextHash;
    case "plan-proposal": return artifact.value.artifactHash;
    case "validation-attestation": return artifact.value.artifactHash;
    case "policy-bundle": return artifact.value.bundleHash;
  }
}

function predecessorHash(artifact: OrchestrationPlanningArtifact) {
  switch (artifact.kind) {
    case "context-snapshot": return artifact.value.correlationId;
    case "plan-proposal": return artifact.value.contextHash;
    case "validation-attestation": return artifact.value.planHash;
    case "policy-bundle": return artifact.value.validationAttestationHash;
  }
}

function artifactId(artifact: OrchestrationPlanningArtifact) {
  return artifact.value.id;
}

function artifactCreatedAt(artifact: OrchestrationPlanningArtifact) {
  switch (artifact.kind) {
    case "context-snapshot": return artifact.value.createdAt;
    case "plan-proposal": return artifact.value.plannedAt;
    case "validation-attestation": return artifact.value.createdAt;
    case "policy-bundle": return artifact.value.createdAt;
  }
}

function assertArtifactIntegrity(artifact: OrchestrationPlanningArtifact) {
  switch (artifact.kind) {
    case "context-snapshot":
      return assertContextSnapshotIntegrity(artifact.value);
    case "plan-proposal":
      return assertGovernedPlanArtifactIntegrity(artifact.value);
    case "validation-attestation":
      return assertPlanValidationArtifactIntegrity(artifact.value);
    case "policy-bundle":
      return assertPolicyBundleArtifactIntegrity(artifact.value);
  }
}

function assertArtifactScope(run: OrchestrationRun, artifact: OrchestrationPlanningArtifact) {
  const value = artifact.value;
  if (
    value.runId !== run.id
    || value.correlationId !== run.correlationId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Planning artifact does not belong to the orchestration run"
    );
  }
  if (artifact.kind === "context-snapshot") {
    if (
      artifact.value.portfolioId !== run.portfolioId
      || artifact.value.companyId !== run.companyId
      || artifact.value.environment !== run.environment
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Context artifact scope does not match orchestration authority"
      );
    }
  }

  if (artifact.kind === "plan-proposal") {
    if (
      artifact.value.plan.scope.portfolioId !== run.portfolioId
      || artifact.value.plan.scope.companyId !== run.companyId
      || artifact.value.plan.scope.environment !== run.environment
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Plan artifact scope does not match orchestration authority"
      );
    }
  }

  if (artifact.kind === "policy-bundle") {
    for (const step of artifact.value.stepPolicies) {
      if (
        step.snapshot.scope.portfolioId !== run.portfolioId
        || step.snapshot.scope.companyId !== run.companyId
        || step.snapshot.scope.environment !== run.environment
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Policy artifact scope does not match orchestration authority"
        );
      }
    }
  }
}

function assertStoredArtifact(row: ArtifactRow) {
  const payload = row.payload;
  if (
    payload.kind !== row.artifact_kind
    || artifactId(payload) !== row.id
    || artifactHash(payload) !== row.artifact_hash
    || payload.value.runId !== row.run_id
    || payload.value.correlationId !== row.correlation_id
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Stored orchestration planning artifact metadata drifted");
  }
  assertArtifactIntegrity(payload);
  return payload;
}

export class PostgresOrchestrationPlanningArtifactStore
implements OrchestrationPlanningArtifactStore {
  constructor(private readonly db: PostgresTransactionalDatabase) {}

  async append(run: OrchestrationRun, artifact: OrchestrationPlanningArtifact) {
    assertArtifactScope(run, artifact);
    assertArtifactIntegrity(artifact);

    return runWithPostgresTenantScope(
      { portfolioId: run.portfolioId, companyId: run.companyId },
      () => this.db.transaction(async (client) => {
        const hash = artifactHash(artifact);
        const id = artifactId(artifact);
        const inserted = await client.query<ArtifactRow>(
          `INSERT INTO orchestration_planning_artifacts (
             id,run_id,correlation_id,portfolio_id,company_id,
             artifact_kind,artifact_hash,predecessor_hash,created_at,payload
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [
            id,
            run.id,
            run.correlationId,
            run.portfolioId,
            run.companyId,
            artifact.kind,
            hash,
            predecessorHash(artifact),
            artifactCreatedAt(artifact),
            JSON.stringify(artifact)
          ]
        );

        if (inserted.rowCount === 1) {
          await new PostgresAuditLedger(client).append(createAuditEvent({
            correlationId: run.correlationId,
            eventType: "orchestration.planning-artifact-created",
            actor: { type: "system", id: "orchestration-planning" },
            scope: {
              userId: run.authorityUserId,
              portfolioId: run.portfolioId,
              companyId: run.companyId
            },
            environment: run.environment,
            entityType: "orchestration-planning-artifact",
            entityId: id,
            newState: artifact.kind,
            provenance: "orchestration:planning-artifact-store",
            metadata: {
              artifactKind: artifact.kind,
              artifactHash: hash,
              runId: run.id
            }
          }));
          return { created: true };
        }

        const existing = await client.query<ArtifactRow>(
          `SELECT * FROM orchestration_planning_artifacts
           WHERE run_id=$1
             AND (id=$2 OR (artifact_kind=$3 AND artifact_hash=$4))
           ORDER BY CASE WHEN id=$2 THEN 0 ELSE 1 END
           LIMIT 1`,
          [run.id, id, artifact.kind, hash]
        );
        const row = existing.rows[0];
        if (!row) {
          throw new ControlPlaneError("UNAVAILABLE", "Planning artifact insert could not be reconstructed");
        }
        const persisted = assertStoredArtifact(row);
        if (
          persisted.kind !== artifact.kind
          || artifactHash(persisted) !== hash
        ) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Planning artifact id already exists with different content"
          );
        }
        return { created: false };
      })
    );
  }

  private latest(
    run: OrchestrationRun,
    kind: OrchestrationPlanningArtifactKind
  ): Promise<OrchestrationPlanningArtifact | null> {
    return runWithPostgresTenantScope(
      { portfolioId: run.portfolioId, companyId: run.companyId },
      () => this.db.transaction(async (client) => {
        const result = await client.query<ArtifactRow>(
          `SELECT * FROM orchestration_planning_artifacts
           WHERE run_id=$1 AND artifact_kind=$2
           ORDER BY created_at DESC,id DESC
           LIMIT 1`,
          [run.id, kind]
        );
        return result.rows[0] ? assertStoredArtifact(result.rows[0]) : null;
      })
    );
  }

  async latestContext(run: OrchestrationRun): Promise<OrchestrationContextSnapshot | null> {
    const artifact = await this.latest(run, "context-snapshot");
    return artifact?.kind === "context-snapshot" ? artifact.value : null;
  }

  async latestPlan(run: OrchestrationRun): Promise<GovernedPlanArtifact | null> {
    const artifact = await this.latest(run, "plan-proposal");
    return artifact?.kind === "plan-proposal" ? artifact.value : null;
  }

  async latestValidation(run: OrchestrationRun): Promise<PlanValidationArtifact | null> {
    const artifact = await this.latest(run, "validation-attestation");
    return artifact?.kind === "validation-attestation" ? artifact.value : null;
  }

  async latestPolicy(run: OrchestrationRun): Promise<PolicyBundleArtifact | null> {
    const artifact = await this.latest(run, "policy-bundle");
    return artifact?.kind === "policy-bundle" ? artifact.value : null;
  }

  async count(run: OrchestrationRun, kind: OrchestrationPlanningArtifactKind) {
    return runWithPostgresTenantScope(
      { portfolioId: run.portfolioId, companyId: run.companyId },
      () => this.db.transaction(async (client) => {
        const result = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM orchestration_planning_artifacts
           WHERE run_id=$1 AND artifact_kind=$2`,
          [run.id, kind]
        );
        return Number(result.rows[0]?.count ?? 0);
      })
    );
  }
}
