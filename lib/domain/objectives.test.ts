import { describe, expect, it } from "vitest";
import {
  activeObjectives,
  combineConstraintDispositions,
  detectObjectiveConflicts,
  evaluateBudget,
  evaluateGuardrails,
  guardrailsForScope
} from "@/lib/domain/objectives";

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

  it("blocks hard budget overruns and requires approval above the soft threshold", () => {
    const budget = {
      id: "budget-1",
      scopeId: "c1",
      currency: "USD",
      period: "monthly" as const,
      hardLimitCents: 100_000,
      approvalThresholdCents: 80_000,
      enabled: true
    };

    expect(evaluateBudget(budget, {
      scopeId: "c1",
      currentSpendCents: 70_000,
      requestedCostCents: 15_000
    }).disposition).toBe("approval-required");

    expect(evaluateBudget(budget, {
      scopeId: "c1",
      currentSpendCents: 95_000,
      requestedCostCents: 10_000
    }).disposition).toBe("blocked");
  });

  it("blocks protected guardrail violations", () => {
    const result = evaluateGuardrails([
      { id: "g1", scopeId: "c1", metric: "availability", operator: "min", value: 99.9, protected: true },
      { id: "g2", scopeId: "c1", metric: "cost-per-job", operator: "max", value: 100, protected: false }
    ], "c1", {
      availability: 98.5,
      "cost-per-job": 120
    });

    expect(result.disposition).toBe("blocked");
    expect(result.violations).toHaveLength(2);
    expect(combineConstraintDispositions("allow", result.disposition)).toBe("blocked");
  });
});
