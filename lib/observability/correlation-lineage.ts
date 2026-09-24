import { ControlPlaneError } from "@/lib/control-plane/errors";

export const CORRELATION_LINEAGE_VERSION = "1.0.0";

export type CorrelationStage =
  | "owner-request"
  | "decision"
  | "plan"
  | "task"
  | "job"
  | "queue"
  | "worker"
  | "provider"
  | "verification"
  | "audit"
  | "owner-result";

export const REQUIRED_CORRELATION_STAGES: readonly CorrelationStage[] = Object.freeze([
  "owner-request",
  "decision",
  "plan",
  "task",
  "job",
  "queue",
  "worker",
  "provider",
  "verification",
  "audit",
  "owner-result"
]);

export interface CorrelationArtifact {
  stage: CorrelationStage;
  correlationId: string;
  id: string;
  occurredAt?: string;
  entityType?: string;
  payload: unknown;
}

const stageOrder = new Map(
  REQUIRED_CORRELATION_STAGES.map((stage, index) => [stage, index])
);

export function reconstructExecutionByCorrelationId(
  correlationId: string,
  artifacts: readonly CorrelationArtifact[]
) {
  if (!correlationId.trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Correlation ID is required");
  }
  const matching = artifacts
    .filter((artifact) => artifact.correlationId === correlationId)
    .sort((left, right) => {
      const stageDelta = (stageOrder.get(left.stage) ?? 999) - (stageOrder.get(right.stage) ?? 999);
      if (stageDelta !== 0) return stageDelta;
      return (left.occurredAt ?? "").localeCompare(right.occurredAt ?? "");
    });

  const stages = new Set(matching.map((artifact) => artifact.stage));
  const missingStages = REQUIRED_CORRELATION_STAGES.filter((stage) => !stages.has(stage));
  return Object.freeze({
    correlationId,
    complete: missingStages.length === 0,
    missingStages: Object.freeze(missingStages),
    artifacts: Object.freeze(matching)
  });
}

export function assertCompleteCorrelationLineage(
  correlationId: string,
  artifacts: readonly CorrelationArtifact[]
) {
  const trace = reconstructExecutionByCorrelationId(correlationId, artifacts);
  if (!trace.complete) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "Correlation lineage is incomplete",
      { details: { missingStages: trace.missingStages.join(",") } }
    );
  }
  return trace;
}
