import { describe, expect, it } from "vitest";
import { DagCompiler } from "@/lib/planning/dag-compiler";
import type { GeneratedTask } from "@/lib/planning/task-generator";
import { TaskGenerator, type TaskGenerationDedupeStore } from "@/lib/planning/task-generator";
import type { AuthorizationConsumptionRecord } from "@/lib/authorization/grants";
import { validPlan } from "@/lib/planning/test-fixture";
import type { PlanProposal } from "@/lib/planning/plan-schema";
import { autoGrantFor, fixtureNow, receiptFor } from "@/lib/planning/test-security-fixture";

class MemoryTaskStore implements TaskGenerationDedupeStore {
  readonly tasks = new Map<string, GeneratedTask>();
  readonly consumptions = new Map<string, AuthorizationConsumptionRecord>();

  async claim(task: GeneratedTask, consumption: AuthorizationConsumptionRecord) {
    const existing = this.tasks.get(task.logicalKey);
    if (existing) {
      return {
        created: false,
        task: existing,
        consumption: existing.authorizationConsumption
      };
    }
    const prior = this.consumptions.get(consumption.grantId);
    if (prior && prior.consumerId !== consumption.consumerId) {
      throw new Error("authorization grant already consumed");
    }
    this.tasks.set(task.logicalKey, task);
    this.consumptions.set(consumption.grantId, consumption);
    return { created: true, task, consumption };
  }
}

function twoStepPlan(): PlanProposal {
  const source = validPlan();
  const first = source.steps[0];
  const second = {
    ...first,
    id: "step-2",
    title: "Inspect a second ref",
    reason: "Compare repository state",
    dependsOn: ["step-1"],
    effects: [{ key: "comparison.complete", operation: "set" as const, value: true }],
    capabilityRequests: [{
      capability: "repository.inspect",
      input: {
        companyId: "company-a",
        repository: "DMART19/GetDone",
        ref: "release"
      }
    }]
  };

  return {
    ...source,
    steps: [first, second],
    estimatedCostCents: 40
  };
}

async function generatedTasks(plan = twoStepPlan()) {
  let counter = 0;
  const generator = new TaskGenerator(
    new MemoryTaskStore(),
    () => `task-${++counter}`,
    () => fixtureNow
  );
  const receipt = receiptFor(plan);
  const authorizationGrants = Object.fromEntries(
    plan.steps.map((step) => [step.id, autoGrantFor(plan, step.id, receipt)])
  );

  const result = await generator.generate({
    plan,
    validationReceipt: receipt,
    authorizationGrants,
    objectiveStatus: "active"
  });

  if (result.status !== "created") {
    throw new Error(`Task fixture failed: ${result.reasons.join("; ")}`);
  }
  return result.tasks;
}

describe("deterministic DAG compiler", () => {
  it("orders dependencies through upstream verification nodes", async () => {
    const tasks = await generatedTasks();
    const dag = new DagCompiler(() => "dag-1", () => new Date("2026-09-20T18:31:00Z")).compile(tasks);

    const firstVerify = dag.nodes.find((node) => node.id === "task-1:verify")!;
    const secondAction = dag.nodes.find((node) => node.id === "task-2:cap:0")!;

    expect(secondAction.dependsOn).toContain(firstVerify.id);
    expect(dag.topologicalOrder.indexOf(firstVerify.id)).toBeLessThan(dag.topologicalOrder.indexOf(secondAction.id));
    expect(dag.resourceSelection).toBe("deferred");
  });

  it("maps every action node to a known typed capability and registry output validation", async () => {
    const dag = new DagCompiler(() => "dag-typed").compile(await generatedTasks());
    const actionNodes = dag.nodes.filter((node) => node.kind === "capability");

    expect(actionNodes.every((node) => node.capability === "repository.inspect")).toBe(true);
    expect(actionNodes.every((node) => node.capabilityBinding === "software.repository")).toBe(true);
    expect(actionNodes.every((node) => node.outputValidation === "capability-registry")).toBe(true);
  });

  it("creates explicit verification and rollback/cancellation semantics", async () => {
    const source = validPlan();
    const plan = {
      ...source,
      steps: [{
        ...source.steps[0],
        rollback: {
          strategy: "compensating-action" as const,
          description: "Undo the change if execution fails",
          cancellationAllowed: true
        }
      }]
    };

    const tasks = await generatedTasks(plan);
    const dag = new DagCompiler(() => "dag-rollback").compile(tasks);

    expect(dag.nodes.some((node) => node.kind === "verification")).toBe(true);
    const rollback = dag.nodes.find((node) => node.kind === "rollback");
    expect(rollback?.runCondition).toBe("on-failure");
    expect(rollback?.cancellationAllowed).toBe(true);
  });

  it("rejects unknown capability mappings", async () => {
    const tasks = await generatedTasks(validPlan());
    const tampered: GeneratedTask = {
      ...tasks[0],
      operations: [{ capability: "execute_anything", input: {} }],
      capabilityRequirements: ["execute_anything"]
    };

    expect(() => new DagCompiler().compile([tampered])).toThrow();
  });

  it("revalidates capability input before compilation", async () => {
    const tasks = await generatedTasks(validPlan());
    const tampered: GeneratedTask = {
      ...tasks[0],
      operations: [{
        capability: "repository.inspect",
        input: { companyId: "company-a", repository: "../unsafe" }
      }]
    };

    expect(() => new DagCompiler().compile([tampered])).toThrow();
  });

  it("rejects unsatisfied task dependencies", async () => {
    const tasks = await generatedTasks(validPlan());
    const tampered: GeneratedTask = {
      ...tasks[0],
      dependsOnLogicalKeys: ["missing-task"]
    };

    expect(() => new DagCompiler().compile([tampered])).toThrow();
  });

  it("rejects task dependency cycles", async () => {
    const tasks = await generatedTasks();
    const first: GeneratedTask = {
      ...tasks[0],
      dependsOnLogicalKeys: [tasks[1].logicalKey]
    };
    const second: GeneratedTask = {
      ...tasks[1],
      dependsOnLogicalKeys: [tasks[0].logicalKey]
    };

    expect(() => new DagCompiler().compile([first, second])).toThrow();
  });

  it("preserves resource requirements as requirements rather than selecting hardware", async () => {
    const dag = new DagCompiler(() => "dag-resource").compile(await generatedTasks(validPlan()));
    const node = dag.nodes.find((candidate) => candidate.kind === "capability")!;

    expect(node.resourceRequirements.execution.environment).toBe("staging");
    expect(node.resourceRequirements.reliability.minimumTier).toBe("standard");
    expect("resourceId" in (node.resourceRequirements as unknown as Record<string, unknown>)).toBe(false);
    expect(dag.resourceSelection).toBe("deferred");
  });

  it("rejects cross-user task graphs even when company scope matches", async () => {
    const tasks = await generatedTasks();
    const tampered: GeneratedTask = {
      ...tasks[1],
      scope: { ...tasks[1].scope, userId: "user-b" }
    };

    expect(() => new DagCompiler().compile([tasks[0], tampered])).toThrow();
  });
});
