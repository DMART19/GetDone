import { describe, expect, it } from "vitest";
import {
  readAuthoritativeOrchestrationRuntimeConfig
} from "@/lib/orchestration/orchestration-worker-runtime.server";

describe("authoritative orchestration worker runtime", () => {
  it("uses finite fail-closed production ceilings", () => {
    const config = readAuthoritativeOrchestrationRuntimeConfig({});
    expect(config.maxPlanCostCents).toBe(10_000);
    expect(config.maxStepCostCents).toBe(5_000);
    expect(config.aiCompanyDailyBudgetCents).toBe(5_000);
    expect(config.aiPortfolioDailyBudgetCents).toBe(20_000);
    expect(config.aiConcurrencyLimit).toBe(2);
    expect(config.validationTtlSeconds).toBe(300);
  });

  it("rejects a step ceiling greater than the plan ceiling", () => {
    expect(() => readAuthoritativeOrchestrationRuntimeConfig({
      GETDONE_ORCHESTRATION_MAX_PLAN_COST_CENTS: "100",
      GETDONE_ORCHESTRATION_MAX_STEP_COST_CENTS: "101"
    })).toThrow(/step cost ceiling/i);
  });

  it("rejects unlimited or non-positive budget configuration", () => {
    expect(() => readAuthoritativeOrchestrationRuntimeConfig({
      GETDONE_AI_COMPANY_DAILY_BUDGET_CENTS: "0"
    })).toThrow(/positive integer/i);
  });
});
