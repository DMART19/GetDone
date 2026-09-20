import { createHash } from "node:crypto";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { PolicyEvaluation } from "@/lib/planning/policy-engine";
import type {
  PlanProposal,
  PlanStep,
  ResourceRequirementEnvelope,
  Rollback,
  VerificationRequirement,
  PlanPrecondition,
  CapabilityRequest
} from "@/lib/planning/plan-schema";
import type { PlanValidationResult } from "@/lib/planning/plan-validator";

export type TaskPriority = "low" | "normal" | "high" | "critical";

export interface AuthorizationLineageEntry {
  kind: "auto-policy" | "decision" | "strong-approval";
  referenceId: string;
  grantedAt: string;
  actorId?: string;
}

export interface GeneratedTask {
  id: string;
  logicalKey: string;
  planId: string;
  planStepId: string;
  scope: Readonly<{
    portfolioId: string;
    companyId: string;
    environment: "development" | "staging" | "production";
    dataClass: "public" | "internal" | "customer" | "sensitive";
  }>;
  source: Readonly<{
    type: PlanProposal["source"]["type"];
    referenceId: string;
  }>;
  reason: string;
  evidenceIds: readonly string[];
  priority: TaskPriority;
  capabilityRequirements: readonly string[];
  operations: readonly CapabilityRequest[];
  authorizationLineage: readonly AuthorizationLineageEntry[];
  dependsOnLogicalKeys: readonly string[];
  preconditions: readonly PlanPrecondition[];
  resourceRequirements: Readonly<ResourceRequirementEnvelope>;
  verificationRequirements: readonly VerificationRequirement[];
  rollback: Readonly<Rollback>;
  estimatedCostCents: number;
  createdAt: string;
}

export interface TaskGenerationDedupeStore {
  /**
   * Durable implementations must atomically claim the logical key.
   * If the key already exists, return the existing authoritative task.
   */
  claim(task: GeneratedTask): Promise<{ created: boolean; task: GeneratedTask }>;
}

export interface TaskGenerationInput {
  plan: PlanProposal;
  validation: PlanValidationResult;
  objectiveStatus?: "active" | "paused" | "completed";
  stepPolicies: Readonly<Record<string, PolicyEvaluation>>;
  authorizationLineage: readonly AuthorizationLineageEntry[];
}

export interface TaskGenerationResult {
  status: "created" | "partial-duplicates" | "duplicates-only" | "blocked";
  tasks: readonly GeneratedTask[];
  duplicateTasks: readonly GeneratedTask[];
  reasons: readonly string[];
}

function sourceReference(plan: PlanProposal) {
  if (plan.source.type === "objective") return plan.source.objectiveId;
  if (plan.source.type === "investigation") return plan.source.investigationId;
  return plan.source.requestId;
}

function priorityForStep(step: PlanStep): TaskPriority {
  if (step.risk.level === "critical") return "critical";
  if (step.risk.level === "high") return "high";
  if (step.resourceRequirements.execution.priority >= 80) return "high";
  if (step.resourceRequirements.execution.priority < 30) return "low";
  return "normal";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function logicalKey(plan: PlanProposal, step: PlanStep) {
  const fingerprint = createHash("sha256")
    .update(stableJson({
      reason: step.reason,
      capabilities: step.capabilityRequests,
      preconditions: step.preconditions,
      effects: step.effects,
      resourceRequirements: step.resourceRequirements,
      verificationRequirements: step.verificationRequirements,
      rollback: step.rollback
    }))
    .digest("hex");

  return [
    plan.scope.portfolioId,
    plan.scope.companyId,
    plan.source.type,
    sourceReference(plan),
    fingerprint
  ].join(":");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object) || Object.isFrozen(object)) return value;
  seen.add(object);
  Object.freeze(object);
  for (const item of Object.values(value as Record<string, unknown>)) {
    deepFreeze(item, seen);
  }
  return value;
}

export class TaskGenerator {
  constructor(
    private readonly dedupe: TaskGenerationDedupeStore,
    private readonly idFactory: () => string = () => crypto.randomUUID(),
    private readonly now: () => Date = () => new Date()
  ) {}

  async generate(input: TaskGenerationInput): Promise<TaskGenerationResult> {
    if (input.validation.status !== "valid") {
      return {
        status: "blocked",
        tasks: [],
        duplicateTasks: [],
        reasons: ["Plan must pass deterministic validation before task generation"]
      };
    }

    if (input.plan.source.type === "objective" && input.objectiveStatus !== "active") {
      return {
        status: "blocked",
        tasks: [],
        duplicateTasks: [],
        reasons: ["Paused/completed objectives cannot create new autonomous work"]
      };
    }

    for (const step of input.plan.steps) {
      const policy = input.stepPolicies[step.id];
      if (!policy || !policy.readyForTaskGeneration) {
        return {
          status: "blocked",
          tasks: [],
          duplicateTasks: [],
          reasons: [`Step is not authorized for task generation: ${step.id}`]
        };
      }

      if (policy.disposition !== "AUTO" && input.authorizationLineage.length === 0) {
        return {
          status: "blocked",
          tasks: [],
          duplicateTasks: [],
          reasons: [`Approved step is missing immutable authorization lineage: ${step.id}`]
        };
      }
    }

    const stepLogicalKeys = new Map(
      input.plan.steps.map((step) => [step.id, logicalKey(input.plan, step)])
    );

    const tasks: GeneratedTask[] = [];
    const duplicateTasks: GeneratedTask[] = [];

    for (const step of input.plan.steps) {
      const policy = input.stepPolicies[step.id];
      const key = stepLogicalKeys.get(step.id)!;
      const createdAt = this.now().toISOString();
      const lineage = policy.disposition === "AUTO" && input.authorizationLineage.length === 0
        ? [{
            kind: "auto-policy" as const,
            referenceId: `policy:${step.id}`,
            grantedAt: createdAt
          }]
        : [...input.authorizationLineage];

      if (lineage.length === 0) {
        throw new ControlPlaneError("VALIDATION_FAILED", "Task requires authorization lineage");
      }

      const candidate: GeneratedTask = deepFreeze({
        id: this.idFactory(),
        logicalKey: key,
        planId: input.plan.id,
        planStepId: step.id,
        scope: {
          portfolioId: input.plan.scope.portfolioId,
          companyId: input.plan.scope.companyId,
          environment: input.plan.scope.environment,
          dataClass: input.plan.scope.dataClass
        },
        source: {
          type: input.plan.source.type,
          referenceId: sourceReference(input.plan)
        },
        reason: step.reason,
        evidenceIds: [
          ...new Set([
            ...input.plan.evidence.map((evidence) => evidence.id),
            ...step.evidenceIds
          ])
        ],
        priority: priorityForStep(step),
        capabilityRequirements: step.capabilityRequests.map((request) => request.capability),
        operations: step.capabilityRequests.map((request) => ({
          capability: request.capability,
          input: request.input
        })),
        authorizationLineage: lineage.map((item) => ({ ...item })),
        dependsOnLogicalKeys: step.dependsOn.map((dependency) => stepLogicalKeys.get(dependency)!),
        preconditions: step.preconditions.map((item) => ({ ...item })),
        resourceRequirements: {
          ...step.resourceRequirements,
          execution: { ...step.resourceRequirements.execution },
          reliability: { ...step.resourceRequirements.reliability },
          data: {
            ...step.resourceRequirements.data,
            allowedRegions: [...step.resourceRequirements.data.allowedRegions]
          },
          economics: { ...step.resourceRequirements.economics },
          compute: step.resourceRequirements.compute
            ? { ...step.resourceRequirements.compute }
            : undefined
        },
        verificationRequirements: step.verificationRequirements.map((item) => ({ ...item })),
        rollback: { ...step.rollback },
        estimatedCostCents: step.estimatedCostCents,
        createdAt
      });

      const claim = await this.dedupe.claim(candidate);
      if (claim.created) {
        tasks.push(claim.task);
      } else {
        duplicateTasks.push(claim.task);
      }
    }

    return {
      status: tasks.length === 0
        ? "duplicates-only"
        : duplicateTasks.length > 0
          ? "partial-duplicates"
          : "created",
      tasks,
      duplicateTasks,
      reasons: []
    };
  }
}
