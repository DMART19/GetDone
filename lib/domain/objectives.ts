export type ObjectiveDirection = "increase" | "decrease" | "maintain";

export interface Objective {
  id: string;
  scopeId: string;
  metric: string;
  direction: ObjectiveDirection;
  target: number;
  priority: number;
  deadline?: string;
  budgetCents?: number;
  status: "active" | "paused" | "completed";
}

export interface Guardrail {
  id: string;
  scopeId: string;
  metric: string;
  operator: "min" | "max" | "equals" | "deny";
  value?: number | string | boolean;
  protected: boolean;
}

export function activeObjectives(objectives: readonly Objective[]) {
  return objectives.filter((objective) => objective.status === "active");
}

export function detectObjectiveConflicts(objectives: readonly Objective[]) {
  const conflicts: Array<{ left: string; right: string; metric: string }> = [];
  const active = activeObjectives(objectives);

  for (let left = 0; left < active.length; left += 1) {
    for (let right = left + 1; right < active.length; right += 1) {
      const a = active[left];
      const b = active[right];
      if (a.scopeId !== b.scopeId || a.metric !== b.metric) continue;
      if (a.direction === "maintain" || b.direction === "maintain" || a.direction !== b.direction) {
        conflicts.push({ left: a.id, right: b.id, metric: a.metric });
      }
    }
  }

  return conflicts;
}

export function guardrailsForScope(guardrails: readonly Guardrail[], scopeId: string) {
  return guardrails.filter((guardrail) => guardrail.scopeId === scopeId);
}
