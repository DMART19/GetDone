import { describe, expect, it } from "vitest";
import { hashPlan, hashPlanStep, planStepHashes } from "@/lib/planning/plan-hash";
import { validPlan } from "@/lib/planning/test-fixture";

describe("plan hashing", () => {
  it("produces stable plan and step hashes", () => {
    const plan = validPlan();
    expect(hashPlan(plan)).toHaveLength(64);
    expect(hashPlanStep(plan.steps[0])).toHaveLength(64);
    expect(planStepHashes(plan)[plan.steps[0].id]).toBe(hashPlanStep(plan.steps[0]));
  });

  it("changes the plan hash when an approved step is mutated", () => {
    const original = validPlan();
    const mutated = {
      ...original,
      steps: [{
        ...original.steps[0],
        estimatedCostCents: original.steps[0].estimatedCostCents + 1
      }]
    };
    expect(hashPlan(mutated)).not.toBe(hashPlan(original));
    expect(hashPlanStep(mutated.steps[0])).not.toBe(hashPlanStep(original.steps[0]));
  });
});
