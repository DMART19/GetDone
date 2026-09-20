import { describe, expect, it } from "vitest";
import { validPlan } from "@/lib/planning/test-fixture";
import { validatePlan, type PlanValidationPolicy } from "@/lib/planning/plan-validator";

const policy: PlanValidationPolicy = {
  trustedScope: {
    portfolioId: "portfolio-a",
    companyId: "company-a"
  },
  allowedEnvironments: ["development", "staging"],
  allowedDataClasses: ["public", "internal"],
  allowedRegions: ["us-west", "us-east"],
  maxPlanCostCents: 500,
  maxStepCostCents: 300,
  minimumReliabilityTier: "standard",
  fallbackRequiredForProduction: true,
  fallbackRequiredForCustomerData: true,
  requireRollbackForRiskAtOrAbove: "high",
  availableCredentialBindings: true
};

describe("deterministic plan validator", () => {
  it("accepts a complete plan without authorizing it", () => {
    const result = validatePlan(validPlan(), policy);
    expect(result.status).toBe("valid");
    expect(result.errors).toHaveLength(0);
    expect(result.orderedStepIds).toEqual(["step-1"]);
  });

  it("rejects server-authority scope mismatch", () => {
    const result = validatePlan(validPlan(), {
      ...policy,
      trustedScope: { portfolioId: "portfolio-a", companyId: "company-b" }
    });
    expect(result.errors.some((issue) => issue.code === "SCOPE_MISMATCH")).toBe(true);
  });

  it("rejects unsupported capabilities", () => {
    const source = validPlan();
    const plan = validPlan({
      requestedCapabilities: ["execute_anything"],
      steps: [{
        ...source.steps[0],
        capabilityRequests: [{ capability: "execute_anything", input: {} }]
      }]
    });
    const result = validatePlan(plan, policy);
    expect(result.errors.some((issue) => issue.code === "UNSUPPORTED_CAPABILITY")).toBe(true);
  });

  it("rejects capability inputs that fail the capability runtime schema", () => {
    const source = validPlan();
    const plan = validPlan({
      steps: [{
        ...source.steps[0],
        capabilityRequests: [{
          capability: "repository.inspect",
          input: { companyId: "company-a", repository: "../unsafe" }
        }]
      }]
    });
    const result = validatePlan(plan, policy);
    expect(result.errors.some((issue) => issue.code === "CAPABILITY_INPUT_INVALID")).toBe(true);
  });

  it("rejects dependency cycles and unknown dependencies", () => {
    const first = validPlan().steps[0];
    const second = {
      ...first,
      id: "step-2",
      title: "Second inspection",
      dependsOn: ["step-1"],
      effects: [{ key: "second.complete", operation: "set" as const, value: true }],
      capabilityRequests: [{
        capability: "repository.inspect",
        input: { companyId: "company-a", repository: "DMART19/GetDone", ref: "develop" }
      }]
    };
    const cyclic = validPlan({
      steps: [{ ...first, dependsOn: ["step-2"] }, second],
      estimatedCostCents: 40
    });
    expect(validatePlan(cyclic, policy).errors.some((issue) => issue.code === "DEPENDENCY_CYCLE")).toBe(true);

    const unknown = validPlan({
      steps: [{ ...first, dependsOn: ["does-not-exist"] }]
    });
    expect(validatePlan(unknown, policy).errors.some((issue) => issue.code === "UNKNOWN_DEPENDENCY")).toBe(true);
  });

  it("detects contradictory unordered effects", () => {
    const first = validPlan().steps[0];
    const second = {
      ...first,
      id: "step-2",
      title: "Contradict repository flag",
      capabilityRequests: [{
        capability: "repository.inspect",
        input: { companyId: "company-a", repository: "DMART19/GetDone", ref: "other" }
      }],
      effects: [{ key: "repository.inspected", operation: "set" as const, value: false }]
    };
    const result = validatePlan(validPlan({
      steps: [first, second],
      estimatedCostCents: 40
    }), policy);
    expect(result.errors.some((issue) => issue.code === "CONTRADICTORY_EFFECTS")).toBe(true);
  });

  it("enforces plan and step cost ceilings", () => {
    const step = { ...validPlan().steps[0], estimatedCostCents: 600 };
    const result = validatePlan(validPlan({
      steps: [step],
      estimatedCostCents: 600
    }), policy);
    expect(result.errors.some((issue) => issue.code === "PLAN_COST_CEILING")).toBe(true);
    expect(result.errors.some((issue) => issue.code === "STEP_COST_CEILING")).toBe(true);
  });

  it("enforces environment, data-class, reliability and fallback policy", () => {
    const source = validPlan();
    const step = source.steps[0];
    const productionPlan = validPlan({
      scope: {
        ...source.scope,
        environment: "production",
        dataClass: "customer"
      },
      steps: [{
        ...step,
        resourceRequirements: {
          ...step.resourceRequirements,
          execution: {
            ...step.resourceRequirements.execution,
            environment: "production"
          },
          reliability: {
            minimumTier: "best-effort",
            fallbackRequired: false,
            maxInterruptionClass: "preemptible"
          },
          data: {
            ...step.resourceRequirements.data,
            classification: "customer",
            customerData: true,
            allowedRegions: ["eu-only"]
          }
        }
      }]
    });

    const result = validatePlan(productionPlan, policy);
    expect(result.errors.some((issue) => issue.code === "ENVIRONMENT_NOT_ALLOWED")).toBe(true);
    expect(result.errors.some((issue) => issue.code === "DATA_CLASS_NOT_ALLOWED")).toBe(true);
    expect(result.errors.some((issue) => issue.code === "REGION_NOT_ALLOWED")).toBe(true);
    expect(result.errors.some((issue) => issue.code === "RELIABILITY_REQUIREMENT")).toBe(true);
    expect(result.errors.some((issue) => issue.code === "FALLBACK_REQUIRED")).toBe(true);
  });

  it("surfaces high-risk missing rollback as an owner decision", () => {
    const source = validPlan();
    const result = validatePlan(validPlan({
      steps: [{
        ...source.steps[0],
        risk: {
          level: "high",
          summary: "High-risk change",
          blastRadius: "company"
        },
        rollback: {
          strategy: "none",
          cancellationAllowed: false
        }
      }]
    }), policy);
    expect(result.status).toBe("owner-decision-required");
    expect(result.ownerDecisions.some((issue) => issue.code === "ROLLBACK_REQUIRED")).toBe(true);
  });
});
