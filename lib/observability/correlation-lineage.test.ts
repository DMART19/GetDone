import { describe, expect, it } from "vitest";
import {
  assertCompleteCorrelationLineage,
  type CorrelationArtifact
} from "@/lib/observability/correlation-lineage";

describe("correlation lineage", () => {
  it("reconstructs an entire execution using only one correlation ID", () => {
    const correlationId = "corr-owner-7f901";
    const otherCorrelationId = "corr-unrelated";
    const stages = [
      ["owner-request", "intent-1"],
      ["decision", "decision-1"],
      ["plan", "plan-1"],
      ["task", "task-1"],
      ["job", "job-1"],
      ["queue", "queue:job-1"],
      ["worker", "lease-1"],
      ["provider", "provider-request-1"],
      ["verification", "evidence-1"],
      ["audit", "audit-1"],
      ["owner-result", "job-result-1"]
    ] as const;

    const artifacts: CorrelationArtifact[] = stages.map(([stage, id], index) => ({
      stage,
      correlationId,
      id,
      occurredAt: new Date(Date.UTC(2026, 8, 24, 16, 0, index)).toISOString(),
      payload: { id, correlationId }
    }));

    artifacts.splice(4, 0, {
      stage: "job",
      correlationId: otherCorrelationId,
      id: "unrelated-job",
      occurredAt: "2026-09-24T16:00:03.500Z",
      payload: { correlationId: otherCorrelationId }
    });

    const trace = assertCompleteCorrelationLineage(correlationId, artifacts);

    expect(trace.complete).toBe(true);
    expect(trace.missingStages).toEqual([]);
    expect(trace.artifacts).toHaveLength(11);
    expect(trace.artifacts.map((artifact) => artifact.stage)).toEqual(
      stages.map(([stage]) => stage)
    );
    expect(trace.artifacts.every((artifact) => artifact.correlationId === correlationId))
      .toBe(true);
    expect(trace.artifacts.some((artifact) => artifact.id === "unrelated-job"))
      .toBe(false);
  });
});
