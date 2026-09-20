import { describe, expect, it } from "vitest";
import { parsePlanProposal } from "@/lib/planning/plan-schema";
import { validPlan } from "@/lib/planning/test-fixture";

describe("plan proposal schema", () => {
  it("accepts a complete structured proposal", () => {
    const parsed = parsePlanProposal(validPlan());
    expect(parsed.source.type).toBe("objective");
    expect(parsed.steps[0].capabilityRequests[0].capability).toBe("repository.inspect");
  });

  it("rejects missing scope before authorization can be considered", () => {
    const candidate = { ...validPlan() } as Record<string, unknown>;
    delete candidate.scope;
    expect(() => parsePlanProposal(candidate)).toThrow();
  });

  it("requires objective traceability for objective-sourced plans", () => {
    expect(() => parsePlanProposal({
      ...validPlan(),
      objective: undefined
    })).toThrow();
  });

  it("requires verification requirements on executable steps", () => {
    const plan = validPlan();
    expect(() => parsePlanProposal({
      ...plan,
      steps: [{ ...plan.steps[0], verificationRequirements: [] }]
    })).toThrow();
  });
});
