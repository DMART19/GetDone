import { describe, expect, it } from "vitest";
import { validPlan } from "@/lib/planning/test-fixture";
import {
  autoGrantFor,
  fixtureNow,
  receiptFor
} from "@/lib/planning/test-security-fixture";
import { TaskGenerator, type GeneratedTask, type TaskGenerationDedupeStore } from "@/lib/planning/task-generator";
import type { PlanValidationReceipt } from "@/lib/planning/validation-receipt";

class MemoryTaskDedupe implements TaskGenerationDedupeStore {
  readonly tasks = new Map<string, GeneratedTask>();

  async claim(task: GeneratedTask) {
    const existing = this.tasks.get(task.logicalKey);
    if (existing) return { created: false, task: existing };
    this.tasks.set(task.logicalKey, task);
    return { created: true, task };
  }
}

function validInput(plan = validPlan()) {
  const receipt = receiptFor(plan);
  const grant = autoGrantFor(plan, plan.steps[0].id, receipt);
  return {
    plan,
    validationReceipt: receipt,
    authorizationGrants: { [plan.steps[0].id]: grant },
    objectiveStatus: "active" as const
  };
}

describe("authorization-bound task generator", () => {
  it("creates immutable scoped tasks from receipt + grant authority", async () => {
    const generator = new TaskGenerator(
      new MemoryTaskDedupe(),
      () => "task-1",
      () => fixtureNow
    );
    const input = validInput();
    const result = await generator.generate(input);

    expect(result.status).toBe("created");
    const task = result.tasks[0];
    expect(task.scope).toEqual({
      userId: "user-a",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "staging",
      resourceId: undefined,
      dataClass: "internal"
    });
    expect(task.authorizationGrantId).toBe(input.authorizationGrants["step-1"].id);
    expect(task.validationReceiptHash).toBe(input.validationReceipt.receiptHash);
    expect(task.authorizationLineage[0].referenceId).toBe(input.authorizationGrants["step-1"].id);
    expect(Object.isFrozen(task)).toBe(true);
    expect(Object.isFrozen(task.operations[0].input as object)).toBe(true);
  });

  it("rejects arbitrary status-valid objects that are not real validation receipts", async () => {
    const plan = validPlan();
    const grantReceipt = receiptFor(plan);
    const grant = autoGrantFor(plan, plan.steps[0].id, grantReceipt);
    const generator = new TaskGenerator(new MemoryTaskDedupe(), undefined, () => fixtureNow);

    const result = await generator.generate({
      plan,
      validationReceipt: { status: "valid" } as PlanValidationReceipt,
      authorizationGrants: { [plan.steps[0].id]: grant },
      objectiveStatus: "active"
    });

    expect(result.status).toBe("blocked");
  });

  it("rejects expired receipts", async () => {
    const input = validInput();
    const generator = new TaskGenerator(
      new MemoryTaskDedupe(),
      undefined,
      () => new Date("2026-09-20T18:32:00Z")
    );
    expect((await generator.generate(input)).status).toBe("blocked");
  });

  it("rejects a receipt after the plan is mutated", async () => {
    const input = validInput();
    const mutated = {
      ...input.plan,
      steps: [{ ...input.plan.steps[0], reason: "changed after validation" }]
    };
    const generator = new TaskGenerator(new MemoryTaskDedupe(), undefined, () => fixtureNow);

    const result = await generator.generate({
      ...input,
      plan: mutated
    });
    expect(result.status).toBe("blocked");
  });

  it("rejects missing authorization grants", async () => {
    const input = validInput();
    const generator = new TaskGenerator(new MemoryTaskDedupe(), undefined, () => fixtureNow);
    const result = await generator.generate({
      ...input,
      authorizationGrants: {}
    });
    expect(result.status).toBe("blocked");
  });

  it("rejects expired authorization grants", async () => {
    const input = validInput();
    const generator = new TaskGenerator(
      new MemoryTaskDedupe(),
      undefined,
      () => new Date("2026-09-20T18:31:00Z")
    );
    expect((await generator.generate(input)).status).toBe("blocked");
  });

  it("rejects scope-mismatched authorization grants", async () => {
    const input = validInput();
    const original = input.authorizationGrants["step-1"];
    const tampered = {
      ...original,
      scope: { ...original.scope, companyId: "company-b" }
    };
    const generator = new TaskGenerator(new MemoryTaskDedupe(), undefined, () => fixtureNow);

    const result = await generator.generate({
      ...input,
      authorizationGrants: { "step-1": tampered }
    });
    expect(result.status).toBe("blocked");
  });

  it("does not generate autonomous work from a paused objective", async () => {
    const input = validInput();
    const generator = new TaskGenerator(new MemoryTaskDedupe(), undefined, () => fixtureNow);
    const result = await generator.generate({
      ...input,
      objectiveStatus: "paused"
    });
    expect(result.status).toBe("blocked");
  });

  it("atomically deduplicates repeated logical task generation", async () => {
    const store = new MemoryTaskDedupe();
    let counter = 0;
    const generator = new TaskGenerator(
      store,
      () => `task-${++counter}`,
      () => fixtureNow
    );
    const input = validInput();

    const first = await generator.generate(input);
    const second = await generator.generate(input);

    expect(first.status).toBe("created");
    expect(second.status).toBe("duplicates-only");
    expect(second.duplicateTasks[0].id).toBe(first.tasks[0].id);
    expect(store.tasks.size).toBe(1);
  });

  it("deduplicates equivalent work regenerated from the same source under a new plan id", async () => {
    const store = new MemoryTaskDedupe();
    let counter = 0;
    const generator = new TaskGenerator(store, () => `task-${++counter}`, () => fixtureNow);

    const firstPlan = validPlan({ id: "plan-first" });
    const secondPlan = validPlan({ id: "plan-regenerated" });
    const first = await generator.generate(validInput(firstPlan));
    const second = await generator.generate(validInput(secondPlan));

    expect(first.status).toBe("created");
    expect(second.status).toBe("duplicates-only");
    expect(second.duplicateTasks[0].id).toBe(first.tasks[0].id);
  });
});
