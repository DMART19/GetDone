import type { ObjectiveRecord } from "@/lib/domain/objective-inbox";

/**
 * Advisory only. This module never creates jobs, consumes approvals, or changes
 * objective state. Every proposed action must enter the existing control plane.
 */
export type ContinuationDecision =
  | "stop" | "wait_for_owner" | "wait_for_dependencies"
  | "investigate" | "continue_existing_plan" | "propose_replan";

export interface ObjectiveContinuationAdvice {
  objectiveId: string;
  decision: ContinuationDecision;
  reason: string;
  requiresAdmission: boolean;
}

export function adviseObjectiveContinuation(
  objective: Pick<ObjectiveRecord, "id" | "status" | "dependsOnObjectiveIds" | "successCriteria">,
  dependencyStatuses: Readonly<Record<string, ObjectiveRecord["status"]>>
): ObjectiveContinuationAdvice {
  const advice = (decision: ContinuationDecision, reason: string, requiresAdmission = false) =>
    Object.freeze({ objectiveId: objective.id, decision, reason, requiresAdmission });

  if (objective.status === "completed" || objective.status === "cancelled") {
    return advice("stop", "Objective is terminal");
  }
  if (objective.status === "needs_owner_input" || objective.status === "blocked") {
    return advice("wait_for_owner", "Owner input or resolution of a blocker is required");
  }
  if (objective.status === "failed" || objective.status === "new_work_required" || objective.status === "partially_completed") {
    return advice("propose_replan", "Existing work needs a reviewed recovery plan", true);
  }
  if (objective.dependsOnObjectiveIds.some(id => dependencyStatuses[id] !== "completed")) {
    return advice("wait_for_dependencies", "One or more dependencies lack verified completion");
  }
  if (!objective.successCriteria.length) {
    return advice("investigate", "Success criteria must be established before autonomous continuation", true);
  }
  return advice("continue_existing_plan", "Eligible for policy-gated evaluation of the existing plan", true);
}
