import { describe, expect, it } from "vitest";
import { validPlan } from "@/lib/planning/test-fixture";
import type { PolicyEvaluation } from "@/lib/planning/policy-engine";
import { TaskGenerator, type GeneratedTask, type TaskGenerationDedupeStore } from "@/lib/planning/task-generator";
import type { PlanValidationResult } from "@/lib/planning/plan-validator";

class MemoryTaskDedupe implements TaskGenerationDedupeStore {
  readonly tasks = new Map<string, GeneratedTask>();

  async claim(task: GeneratedTask) {
    const existing = this.tasks.get(task.logicalKey);
    if (existing) return { created: false, task: existing };
    this.tasks.set(task.logicalKey, task);
    return { created: true, task };
  }
}

const validValidation: PlanValidationResult = {
  status: "valid",
  errors: [],
  warnings: [],
  ownerDecisions: [],
  orderedStepIds: ["step-1"],
  totalStepCostCents: 20
};

function autoPolicy(): PolicyEvaluation {
  return {
    disposition: "AUTO",
    reasons: [],
    capability: undefined,
    requiresFreshStepUp: false,
    approvalSatisfied: true,
    readyForTaskGeneration: true
  };
}

describe("autonomous task generator", () => {
  it("creates immutable scoped tasks with evidence, reason, capability and authorization lineage", async () => {
    const store = new MemoryTaskDedupe();
    const generator = new TaskGenerator(store, () => "task-1", () => new Date("2026-09-20T16:10:00Z"));
    const plan = validPlan();

    const result = await generator.generate({
      plan,
      validation: validValidation,
      objectiveStatus: "active",
      stepPolicies: { "step-1": autoPolicy() },
      authorizationLineage: []
    });

    expect(result.status).toBe("created");
    expect(result.tasks).toHaveLength(1);
    const task = result.tasks[0];

    expect(task.scope).toEqual({
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "staging",
      dataClass: "internal"
    });
    expect(task.reason).toBe(plan.steps[0].reason);
    expect(task.evidenceIds).toContain("evidence-1");
    expect(task.capabilityRequirements).toEqual(["repository.inspect"]);
    expect(task.authorizationLineage[0].kind).toBe("auto-policy");
    expect(Object.isFrozen(task)).toBe(true);
    expect(Object.isFrozen(task.scope)).toBe(true);
    expect(Object.isFrozen(task.authorizationLineage)).toBe(true);
    expect(Object.isFrozen(task.operations[0].input as object)).toBe(true);
  });

  it("does not generate autonomous work from a paused objective", async () => {
    const generator = new TaskGenerator(new MemoryTaskDedupe());
    const result = await generator.generate({
      plan: validPlan(),
      validation: validValidation,
      objectiveStatus: "paused",
      stepPolicies: { "step-1": autoPolicy() },
      authorizationLineage: []
    });

    expect(result.status).toBe("blocked");
    expect(result.tasks).toHaveLength(0);
  });

  it("does not generate work when any step is not authorized", async () => {
    const generator = new TaskGenerator(new MemoryTaskDedupe());
    const blockedPolicy: PolicyEvaluation = {
      ...autoPolicy(),
      disposition: "BLOCKED",
      approvalSatisfied: false,
      readyForTaskGeneration: false
    };

    const result = await generator.generate({
      plan: validPlan(),
      validation: validValidation,
      objectiveStatus: "active",
      stepPolicies: { "step-1": blockedPolicy },
      authorizationLineage: []
    });

    expect(result.status).toBe("blocked");
  });

  it("atomically deduplicates repeated logical task generation", async () => {
    const store = new MemoryTaskDedupe();
    let counter = 0;
    const generator = new TaskGenerator(
      store,
      () => `task-${++counter}`,
      () => new Date("2026-09-20T16:10:00Z")
    );
    const input = {
      plan: validPlan(),
      validation: validValidation,
      objectiveStatus: "active" as const,
      stepPolicies: { "step-1": autoPolicy() },
      authorizationLineage: [] as const
    };

    const first = await generator.generate(input);
    const second = await generator.generate(input);

    expect(first.status).toBe("created");
    expect(second.status).toBe("duplicates-only");
    expect(second.duplicateTasks[0].id).toBe(first.tasks[0].id);
    expect(store.tasks).toHaveSize(1);
  });

  it("deduplicates equivalent work regenerated from the same source under a new plan id", async () => {
    const store = new MemoryTaskDedupe();
    let counter = 0;
    const generator = new TaskGenerator(store, () => `task-${++counter}`);

    const first = await generator.generate({
      plan: validPlan({ id: "plan-first" }),
      validation: validValidation,
      objectiveStatus: "active",
      stepPolicies: { "step-1": autoPolicy() },
      authorizationLineage: []
    });

    const second = await generator.generate({
      plan: validPlan({ id: "plan-regenerated" }),
      validation: validValidation,
      objectiveStatus: "active",
      stepPolicies: { "step-1": autoPolicy() },
      authorizationLineage: []
    });

    expect(first.status).toBe("created");
    expect(second.status).toBe("duplicates-only");
    expect(second.duplicateTasks[0].id).toBe(first.tasks[0].id);
  });

  it("preserves explicit approval lineage for approved work", async () => {
    const approvalPolicy: PolicyEvaluation = {
      ...autoPolicy(),
      disposition: "APPROVAL_REQUIRED",
      approvalSatisfied: true,
      readyForTaskGeneration: true
    };
    const generator = new TaskGenerator(new MemoryTaskDedupe(), () => "task-approved");

    const result = await generator.generate({
      plan: validPlan(),
      validation: validValidation,
      objectiveStatus: "active",
      stepPolicies: { "step-1": approvalPolicy },
      authorizationLineage: [{
        kind: "decision",
        referenceId: "decision-42",
        grantedAt: "2026-09-20T16:09:00Z",
        actorId: "user-a"
      }]
    });

    expect(result.tasks[0].authorizationLineage).toEqual([{
      kind: "decision",
      referenceId: "decision-42",
      grantedAt: "2026-09-20T16:09:00Z",
      actorId: "user-a"
    }]);
  });
});
