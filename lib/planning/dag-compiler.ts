import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  getCapability,
  validateCapabilityInput,
  type CapabilityDefinition
} from "@/lib/domain/capabilities";
import type { CapabilityName } from "@/lib/domain/capability-schemas";
import type {
  ResourceRequirementEnvelope,
  Rollback,
  VerificationRequirement,
  PlanPrecondition
} from "@/lib/planning/plan-schema";
import type { GeneratedTask } from "@/lib/planning/task-generator";

export type ExecutableNodeKind = "capability" | "verification" | "rollback";

export interface ExecutableDagNode {
  id: string;
  kind: ExecutableNodeKind;
  taskId: string;
  taskLogicalKey: string;
  dependsOn: readonly string[];
  capability?: CapabilityName;
  capabilityBinding?: string;
  capabilityInput?: unknown;
  outputValidation?: "capability-registry";
  preconditions: readonly PlanPrecondition[];
  verificationRequirements: readonly VerificationRequirement[];
  rollback: Readonly<Rollback>;
  cancellationAllowed: boolean;
  runCondition: "normal" | "on-failure";
  resourceRequirements: Readonly<ResourceRequirementEnvelope>;
}

export interface ExecutableDag {
  id: string;
  scope: Readonly<GeneratedTask["scope"]>;
  taskIds: readonly string[];
  nodes: readonly ExecutableDagNode[];
  topologicalOrder: readonly string[];
  resourceSelection: "deferred";
  compiledAt: string;
}

function topologicalTaskOrder(tasks: readonly GeneratedTask[]) {
  const byKey = new Map(tasks.map((task) => [task.logicalKey, task]));
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const task of tasks) {
    indegree.set(task.logicalKey, 0);
    outgoing.set(task.logicalKey, []);
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOnLogicalKeys) {
      if (!byKey.has(dependency)) {
        throw new ControlPlaneError(
          "VALIDATION_FAILED",
          `Task dependency is not present in compilation input: ${dependency}`
        );
      }
      if (dependency === task.logicalKey) {
        throw new ControlPlaneError("VALIDATION_FAILED", "Task cannot depend on itself");
      }
      indegree.set(task.logicalKey, (indegree.get(task.logicalKey) ?? 0) + 1);
      outgoing.get(dependency)?.push(task.logicalKey);
    }
  }

  const queue = [...tasks.filter((task) => (indegree.get(task.logicalKey) ?? 0) === 0).map((task) => task.logicalKey)].sort();
  const ordered: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    ordered.push(current);
    for (const next of outgoing.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }

  if (ordered.length !== tasks.length) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Task graph contains a dependency cycle");
  }

  return ordered;
}

function assertSameScope(tasks: readonly GeneratedTask[]) {
  const first = tasks[0]?.scope;
  if (!first) throw new ControlPlaneError("VALIDATION_FAILED", "At least one task is required");

  for (const task of tasks) {
    if (
      task.scope.portfolioId !== first.portfolioId
      || task.scope.companyId !== first.companyId
      || task.scope.environment !== first.environment
      || task.scope.dataClass !== first.dataClass
    ) {
      throw new ControlPlaneError("FORBIDDEN", "A compiled DAG cannot cross authoritative task scope");
    }
  }

  return first;
}

function requireCapability(name: string): CapabilityDefinition {
  const capability = getCapability(name);
  if (!capability || !capability.enabled) {
    throw new ControlPlaneError("VALIDATION_FAILED", `Unknown/disabled capability in executable graph: ${name}`);
  }
  return capability;
}

function capabilityNodeId(task: GeneratedTask, index: number) {
  return `${task.id}:cap:${index}`;
}

function verificationNodeId(task: GeneratedTask) {
  return `${task.id}:verify`;
}

function rollbackNodeId(task: GeneratedTask) {
  return `${task.id}:rollback`;
}

export class DagCompiler {
  constructor(
    private readonly idFactory: () => string = () => crypto.randomUUID(),
    private readonly now: () => Date = () => new Date()
  ) {}

  compile(tasks: readonly GeneratedTask[]): ExecutableDag {
    const scope = assertSameScope(tasks);
    const orderedTaskKeys = topologicalTaskOrder(tasks);
    const byKey = new Map(tasks.map((task) => [task.logicalKey, task]));
    const nodes: ExecutableDagNode[] = [];

    for (const taskKey of orderedTaskKeys) {
      const task = byKey.get(taskKey)!;
      const upstreamVerificationNodes = task.dependsOnLogicalKeys.map((dependency) => {
        const upstream = byKey.get(dependency);
        if (!upstream) {
          throw new ControlPlaneError("VALIDATION_FAILED", `Unsatisfied task dependency: ${dependency}`);
        }
        return verificationNodeId(upstream);
      });

      let previousActionDependencies = upstreamVerificationNodes;
      task.operations.forEach((operation, index) => {
        const capability = requireCapability(operation.capability);
        const validatedInput = validateCapabilityInput(operation.capability, operation.input);

        const node: ExecutableDagNode = Object.freeze({
          id: capabilityNodeId(task, index),
          kind: "capability",
          taskId: task.id,
          taskLogicalKey: task.logicalKey,
          dependsOn: Object.freeze([...previousActionDependencies]),
          capability: capability.name,
          capabilityBinding: capability.adapterBinding,
          capabilityInput: validatedInput,
          outputValidation: "capability-registry",
          preconditions: Object.freeze(task.preconditions.map((item) => Object.freeze({ ...item }))),
          verificationRequirements: Object.freeze([]),
          rollback: task.rollback,
          cancellationAllowed: task.rollback.cancellationAllowed,
          runCondition: "normal",
          resourceRequirements: task.resourceRequirements
        });
        nodes.push(node);
        previousActionDependencies = [node.id];
      });

      const verificationNode: ExecutableDagNode = Object.freeze({
        id: verificationNodeId(task),
        kind: "verification",
        taskId: task.id,
        taskLogicalKey: task.logicalKey,
        dependsOn: Object.freeze([...previousActionDependencies]),
        preconditions: Object.freeze([]),
        verificationRequirements: task.verificationRequirements,
        rollback: task.rollback,
        cancellationAllowed: false,
        runCondition: "normal",
        resourceRequirements: task.resourceRequirements
      });
      nodes.push(verificationNode);

      if (task.rollback.strategy !== "none") {
        nodes.push(Object.freeze({
          id: rollbackNodeId(task),
          kind: "rollback",
          taskId: task.id,
          taskLogicalKey: task.logicalKey,
          dependsOn: Object.freeze([...previousActionDependencies]),
          preconditions: Object.freeze([]),
          verificationRequirements: Object.freeze([]),
          rollback: task.rollback,
          cancellationAllowed: task.rollback.cancellationAllowed,
          runCondition: "on-failure",
          resourceRequirements: task.resourceRequirements
        }));
      }
    }

    const normalNodes = nodes.filter((node) => node.runCondition === "normal");
    const nodeById = new Map(normalNodes.map((node) => [node.id, node]));
    const indegree = new Map(normalNodes.map((node) => [node.id, 0]));
    const outgoing = new Map(normalNodes.map((node) => [node.id, [] as string[]]));

    for (const node of normalNodes) {
      for (const dependency of node.dependsOn) {
        if (!nodeById.has(dependency)) {
          throw new ControlPlaneError("VALIDATION_FAILED", `Executable node has unsatisfied dependency: ${dependency}`);
        }
        indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
        outgoing.get(dependency)?.push(node.id);
      }
    }

    const queue = [...normalNodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id)].sort();
    const topologicalOrder: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      topologicalOrder.push(current);
      for (const next of outgoing.get(current) ?? []) {
        const remaining = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, remaining);
        if (remaining === 0) {
          queue.push(next);
          queue.sort();
        }
      }
    }

    if (topologicalOrder.length !== normalNodes.length) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Executable DAG contains a cycle");
    }

    return Object.freeze({
      id: this.idFactory(),
      scope: Object.freeze({ ...scope }),
      taskIds: Object.freeze(tasks.map((task) => task.id)),
      nodes: Object.freeze(nodes),
      topologicalOrder: Object.freeze(topologicalOrder),
      resourceSelection: "deferred",
      compiledAt: this.now().toISOString()
    });
  }
}
