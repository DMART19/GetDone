import { createHash } from "node:crypto";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthorizationConsumptionRecord, AuthorizationGrant } from "@/lib/authorization/grants";
import { assertAuthorizationGrant, createAuthorizationConsumptionRecord } from "@/lib/authorization/grants";
import type {
  PlanProposal,
  PlanStep,
  ResourceRequirementEnvelope,
  Rollback,
  VerificationRequirement,
  PlanPrecondition,
  CapabilityRequest
} from "@/lib/planning/plan-schema";
import type { PlanValidationReceipt } from "@/lib/planning/validation-receipt";
import { assertValidationReceipt } from "@/lib/planning/validation-receipt";

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
    userId: string;
    portfolioId: string;
    companyId: string;
    environment: "development" | "staging" | "production";
    resourceId?: string;
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
  authorizationGrantId: string;
  authorizationGrantHash: string;
  authorizationConsumption: AuthorizationConsumptionRecord;
  validationReceiptId: string;
  validationReceiptHash: string;
  policySnapshotId: string;
  policySnapshotHash: string;
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
   * Durable implementations MUST atomically persist the logical task claim
   * and its authorization-consumption record in one transaction.
   * A grant already consumed by different work MUST fail closed.
   */
  claim(
    task: GeneratedTask,
    consumption: AuthorizationConsumptionRecord
  ): Promise<{ created: boolean; task: GeneratedTask; consumption: AuthorizationConsumptionRecord }>;
}

export interface TaskGenerationInput {
  plan: PlanProposal;
  validationReceipt: PlanValidationReceipt;
  authorizationGrants: Readonly<Record<string, AuthorizationGrant>>;
  objectiveStatus?: "active" | "paused" | "completed";
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
      planStepId: step.id,
      reason: step.reason,
      dependsOn: step.dependsOn,
      conflictsWith: step.conflictsWith,
      capabilities: step.capabilityRequests,
      preconditions: step.preconditions,
      effects: step.effects,
      expectedOutcome: step.expectedOutcome,
      risk: step.risk,
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

function lineageFromGrant(grant: AuthorizationGrant): AuthorizationLineageEntry[] {
  return [{
    kind: grant.disposition === "AUTO"
      ? "auto-policy"
      : grant.disposition === "STRONG_APPROVAL"
        ? "strong-approval"
        : "decision",
    referenceId: grant.id,
    grantedAt: grant.issuedAt,
    actorId: grant.actor.id
  }];
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
    const now = this.now();
    try {
      assertValidationReceipt(input.validationReceipt, input.plan, now.getTime());
    } catch (error) {
      return {
        status: "blocked",
        tasks: [],
        duplicateTasks: [],
        reasons: [error instanceof Error ? error.message : "Validation receipt is invalid"]
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

    const validatedGrants = new Map<string, AuthorizationGrant>();

    for (const step of input.plan.steps) {
      const grant = input.authorizationGrants[step.id];
      if (!grant) {
        return {
          status: "blocked",
          tasks: [],
          duplicateTasks: [],
          reasons: [`Missing authorization grant for plan step: ${step.id}`]
        };
      }

      try {
        assertAuthorizationGrant({
          grant,
          plan: input.plan,
          stepId: step.id,
          receipt: input.validationReceipt,
          scope: grant.scope,
          now: now.getTime()
        });
      } catch (error) {
        return {
          status: "blocked",
          tasks: [],
          duplicateTasks: [],
          reasons: [error instanceof Error ? error.message : `Invalid authorization grant: ${step.id}`]
        };
      }
      validatedGrants.set(step.id, grant);
    }

    const stepLogicalKeys = new Map(
      input.plan.steps.map((step) => [step.id, logicalKey(input.plan, step)])
    );

    const tasks: GeneratedTask[] = [];
    const duplicateTasks: GeneratedTask[] = [];

    for (const step of input.plan.steps) {
      const grant = validatedGrants.get(step.id);
      if (!grant) throw new ControlPlaneError("FORBIDDEN", "Validated authorization grant disappeared");

      const key = stepLogicalKeys.get(step.id)!;
      const taskId = this.idFactory();
      const authorizationConsumption = createAuthorizationConsumptionRecord({
        id: `authorization-consumption:${grant.id}`,
        grant,
        consumerType: "task",
        consumerId: taskId,
        consumedAt: now.toISOString()
      });
      const candidate: GeneratedTask = deepFreeze({
        id: taskId,
        logicalKey: key,
        planId: input.plan.id,
        planStepId: step.id,
        scope: {
          userId: grant.scope.userId,
          portfolioId: input.plan.scope.portfolioId,
          companyId: input.plan.scope.companyId,
          environment: input.plan.scope.environment,
          resourceId: grant.scope.resourceId,
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
        authorizationLineage: lineageFromGrant(grant),
        authorizationGrantId: grant.id,
        authorizationGrantHash: grant.grantHash,
        authorizationConsumption,
        validationReceiptId: input.validationReceipt.id,
        validationReceiptHash: input.validationReceipt.receiptHash,
        policySnapshotId: grant.policySnapshotId,
        policySnapshotHash: grant.policySnapshotHash,
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
        createdAt: now.toISOString()
      });

      const claim = await this.dedupe.claim(candidate, authorizationConsumption);
      if (claim.consumption.grantId !== grant.id || claim.consumption.consumerId !== claim.task.id) {
        throw new ControlPlaneError("FORBIDDEN", "Atomic task claim returned mismatched authorization consumption");
      }
      if (claim.created) tasks.push(claim.task);
      else duplicateTasks.push(claim.task);
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
