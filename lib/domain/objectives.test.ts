import { describe, expect, it } from "vitest";
import { activeObjectives, detectObjectiveConflicts, guardrailsForScope } from "@/lib/domain/objectives";

describe("objectives and guardrails", () => {
  it("excludes paused objectives from active work", () => {
    expect(activeObjectives([
      { id: "o1", scopeId: "c1", metric: "revenue", direction: "increase", target: 10, priority: 1, status: "active" },
      { id: "o2", scopeId: "c1", metric: "cost", direction: "decrease", target: 10, priority: 2, status: "paused" }
    ]).map((objective) => objective.id)).toEqual(["o1"]);
  });

  it("detects conflicting directions on the same scoped metric", () => {
    const conflicts = detectObjectiveConflicts([
      { id: "o1", scopeId: "c1", metric: "compute-cost", direction: "increase", target: 10, priority: 1, status: "active" },
      { id: "o2", scopeId: "c1", metric: "compute-cost", direction: "decrease", target: 10, priority: 2, status: "active" }
    ]);
    expect(conflicts).toHaveLength(1);
  });

  it("returns only guardrails for the requested scope", () => {
    expect(guardrailsForScope([
      { id: "g1", scopeId: "c1", metric: "availability", operator: "min", value: 99.9, protected: true },
      { id: "g2", scopeId: "c2", metric: "availability", operator: "min", value: 99.9, protected: true }
    ], "c1").map((guardrail) => guardrail.id)).toEqual(["g1"]);
  });
});
