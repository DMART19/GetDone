import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { ObjectiveRecord } from "@/lib/domain/objective-inbox";
import type { NormalizedEvidence, OperationScope, OwnerInboxItem } from "./contracts";
import { authorizedEvidence } from "./evidence";
import { inboxObjectId } from "./inbox";

export interface ObjectiveMetric { topic: string; key: string; target: number; operator: "gte" | "lte" }
export interface ObjectiveEvaluation {
  id: string; portfolioId: string; companyId: string; environment: OperationScope["environment"];
  objectiveId: string; observedAt: string; current: number | null; delta: number | null;
  evidenceIds: readonly string[]; missingEvidence: readonly string[]; blockers: readonly string[];
  recommendedNextAction: string; ownerInputRequired: boolean; achieved: boolean;
  metricHash: string; consequentialExecutionAuthorized: false;
}
export function evaluateObjective(scope: OperationScope, objective: ObjectiveRecord, metric: ObjectiveMetric,
  evidence: readonly NormalizedEvidence[], now: string, previous?: ObjectiveEvaluation): ObjectiveEvaluation {
  if (objective.portfolioId !== scope.portfolioId || objective.companyId !== scope.companyId || objective.environment !== scope.environment
    || !Number.isFinite(metric.target) || !["gte", "lte"].includes(metric.operator)) throw new ControlPlaneError("FORBIDDEN", "Objective evaluation requires a scoped measurable objective");
  const supported = authorizedEvidence(evidence, scope, metric.topic, ["public", "internal"], Date.parse(now))
    .filter(e => typeof e.facts[metric.key] === "number").sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  const current = supported.length ? supported[0].facts[metric.key] as number : null;
  const metricHash = sha256Hex(metric);
  const achieved = current !== null && (metric.operator === "gte" ? current >= metric.target : current <= metric.target);
  const blocked = ["blocked", "failed", "needs_owner_input"].includes(objective.status);
  const ownerInputRequired = current === null || blocked;
  return { id: `objective-evaluation:${sha256Hex({ scope, objectiveId: objective.id, now, metricHash })}`,
    portfolioId: scope.portfolioId, companyId: scope.companyId, environment: scope.environment, objectiveId: objective.id,
    observedAt: now, current, delta: previous?.metricHash === metricHash && previous.current !== null && previous.current !== undefined
      && previous.portfolioId === scope.portfolioId && previous.companyId === scope.companyId && previous.environment === scope.environment
      && previous.objectiveId === objective.id && Date.parse(previous.observedAt) < Date.parse(now)
      && current !== null ? current - previous.current : null,
    evidenceIds: supported.map(e => e.evidenceId), missingEvidence: current === null ? [`Fresh ${metric.topic} evidence containing numeric ${metric.key}`] : [],
    blockers: blocked ? [`Objective is ${objective.status}`] : [],
    recommendedNextAction: current === null ? "Connect or refresh the required read-only evidence source"
      : blocked ? "Review the objective blocker" : achieved ? "Review measured progress against the objective's full success criteria" : "Investigate the measured gap using read-only evidence",
    ownerInputRequired, achieved, metricHash, consequentialExecutionAuthorized: false };
}
export function evaluationInbox(scope: OperationScope, result: ObjectiveEvaluation): OwnerInboxItem {
  return { id: inboxObjectId(scope, "objective", result.objectiveId), portfolioId: scope.portfolioId, companyId: scope.companyId,
    environment: scope.environment, userId: scope.userId, objectType: "objective", objectId: result.objectiveId,
    kind: "recommendation", state: "open", summary: result.recommendedNextAction, urgency: result.blockers.length ? 1 : 0.4,
    impact: 0.5, confidence: result.evidenceIds.length ? 0.85 : 0.75, createdAt: result.observedAt, updatedAt: result.observedAt,
    sensitivity: "internal", nextAction: { label: "Review objective", href: `/objectives/${encodeURIComponent(result.objectiveId)}` } };
}
