import { getCapability, validateCapabilityInput } from "@/lib/domain/capabilities";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { hashPlan } from "@/lib/planning/plan-hash";
import type { CapabilityDefinition } from "@/lib/domain/capabilities";
import type { PlanEffect, PlanProposal, PlanStep } from "@/lib/planning/plan-schema";

export type PlanValidationSeverity = "error" | "warning" | "owner-decision";

export interface PlanValidationIssue {
  code:
    | "SCOPE_MISMATCH"
    | "UNSUPPORTED_CAPABILITY"
    | "CAPABILITY_INPUT_INVALID"
    | "CAPABILITY_DECLARATION_MISSING"
    | "UNUSED_CAPABILITY_DECLARATION"
    | "UNKNOWN_DEPENDENCY"
    | "SELF_DEPENDENCY"
    | "DEPENDENCY_CYCLE"
    | "EXPLICIT_STEP_CONFLICT"
    | "CONTRADICTORY_EFFECTS"
    | "DUPLICATE_WORK"
    | "PLAN_COST_CEILING"
    | "STEP_COST_CEILING"
    | "ESTIMATED_COST_UNDERSPECIFIED"
    | "ENVIRONMENT_NOT_ALLOWED"
    | "DATA_CLASS_NOT_ALLOWED"
    | "REGION_NOT_ALLOWED"
    | "RELIABILITY_REQUIREMENT"
    | "FALLBACK_REQUIRED"
    | "ROLLBACK_REQUIRED"
    | "CREDENTIAL_BINDING_REQUIRED";
  severity: PlanValidationSeverity;
  message: string;
  stepId?: string;
  capability?: string;
}

export interface PlanValidationPolicy {
  trustedScope: {
    portfolioId: string;
    companyId: string;
  };
  allowedEnvironments: readonly ("development" | "staging" | "production")[];
  allowedDataClasses: readonly ("public" | "internal" | "customer" | "sensitive")[];
  allowedRegions?: readonly string[];
  maxPlanCostCents: number;
  maxStepCostCents?: number;
  minimumReliabilityTier?: "best-effort" | "standard" | "high";
  fallbackRequiredForProduction?: boolean;
  fallbackRequiredForCustomerData?: boolean;
  requireRollbackForRiskAtOrAbove?: "medium" | "high" | "critical";
  availableCredentialBindings?: boolean;
}

export interface PlanValidationResult {
  status: "valid" | "invalid" | "owner-decision-required";
  errors: readonly PlanValidationIssue[];
  warnings: readonly PlanValidationIssue[];
  ownerDecisions: readonly PlanValidationIssue[];
  orderedStepIds: readonly string[];
  totalStepCostCents: number;
}

const riskRank = { low: 0, medium: 1, high: 2, critical: 3 } as const;
const reliabilityRank = { "best-effort": 0, standard: 1, high: 2 } as const;

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

function topologicalOrder(steps: readonly PlanStep[]) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const step of steps) {
    indegree.set(step.id, 0);
    outgoing.set(step.id, []);
  }

  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency) || dependency === step.id) continue;
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      outgoing.get(dependency)?.push(step.id);
    }
  }

  const queue = [...steps.filter((step) => (indegree.get(step.id) ?? 0) === 0).map((step) => step.id)].sort();
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

  return { ordered, hasCycle: ordered.length !== steps.length };
}

function dependsTransitively(steps: readonly PlanStep[], from: string, target: string) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const seen = new Set<string>();
  const stack = [...(byId.get(from)?.dependsOn ?? [])];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(byId.get(current)?.dependsOn ?? []));
  }

  return false;
}

function effectsContradict(left: PlanEffect, right: PlanEffect) {
  if (left.key !== right.key) return false;
  if (left.operation === "set" && right.operation === "set") return left.value !== right.value;
  if (
    (left.operation === "increase" && right.operation === "decrease")
    || (left.operation === "decrease" && right.operation === "increase")
  ) return true;
  if (
    (left.operation === "enable" && right.operation === "disable")
    || (left.operation === "disable" && right.operation === "enable")
  ) return true;
  return false;
}

function capabilityIssue(
  issues: PlanValidationIssue[],
  step: PlanStep,
  capability: string,
  input: unknown,
  definition: CapabilityDefinition | undefined
) {
  if (!definition || !definition.enabled) {
    issues.push({
      code: "UNSUPPORTED_CAPABILITY",
      severity: "error",
      message: `Capability is unavailable: ${capability}`,
      stepId: step.id,
      capability
    });
    return;
  }

  try {
    validateCapabilityInput(capability, input);
  } catch {
    issues.push({
      code: "CAPABILITY_INPUT_INVALID",
      severity: "error",
      message: `Capability input failed runtime validation: ${capability}`,
      stepId: step.id,
      capability
    });
  }
}

export function validatePlan(
  plan: PlanProposal,
  policy: PlanValidationPolicy
): PlanValidationResult {
  const issues: PlanValidationIssue[] = [];
  const stepIds = new Set(plan.steps.map((step) => step.id));
  const declaredCapabilities = new Set(plan.requestedCapabilities);
  const usedCapabilities = new Set<string>();

  if (
    plan.scope.portfolioId !== policy.trustedScope.portfolioId
    || plan.scope.companyId !== policy.trustedScope.companyId
  ) {
    issues.push({
      code: "SCOPE_MISMATCH",
      severity: "error",
      message: "Plan scope does not match server-resolved portfolio/company authority"
    });
  }

  if (!policy.allowedEnvironments.includes(plan.scope.environment)) {
    issues.push({
      code: "ENVIRONMENT_NOT_ALLOWED",
      severity: "error",
      message: `Environment is not allowed by policy: ${plan.scope.environment}`
    });
  }

  if (!policy.allowedDataClasses.includes(plan.scope.dataClass)) {
    issues.push({
      code: "DATA_CLASS_NOT_ALLOWED",
      severity: "error",
      message: `Data class is not allowed by policy: ${plan.scope.dataClass}`
    });
  }

  const totalStepCostCents = plan.steps.reduce((total, step) => total + step.estimatedCostCents, 0);
  if (plan.estimatedCostCents > policy.maxPlanCostCents || totalStepCostCents > policy.maxPlanCostCents) {
    issues.push({
      code: "PLAN_COST_CEILING",
      severity: "error",
      message: "Plan cost exceeds the configured deterministic ceiling"
    });
  }

  if (plan.estimatedCostCents < totalStepCostCents) {
    issues.push({
      code: "ESTIMATED_COST_UNDERSPECIFIED",
      severity: "error",
      message: "Plan estimated cost is lower than the sum of step estimates"
    });
  }

  const signatures = new Map<string, string>();
  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) {
        issues.push({
          code: "UNKNOWN_DEPENDENCY",
          severity: "error",
          message: `Unknown dependency: ${dependency}`,
          stepId: step.id
        });
      }
      if (dependency === step.id) {
        issues.push({
          code: "SELF_DEPENDENCY",
          severity: "error",
          message: "A plan step cannot depend on itself",
          stepId: step.id
        });
      }
    }

    for (const conflict of step.conflictsWith) {
      if (stepIds.has(conflict)) {
        issues.push({
          code: "EXPLICIT_STEP_CONFLICT",
          severity: "error",
          message: `Plan includes explicitly conflicting steps: ${step.id} and ${conflict}`,
          stepId: step.id
        });
      }
    }

    if (policy.maxStepCostCents !== undefined && step.estimatedCostCents > policy.maxStepCostCents) {
      issues.push({
        code: "STEP_COST_CEILING",
        severity: "error",
        message: "Step cost exceeds the configured deterministic ceiling",
        stepId: step.id
      });
    }

    if (step.resourceRequirements.execution.environment !== plan.scope.environment) {
      issues.push({
        code: "ENVIRONMENT_NOT_ALLOWED",
        severity: "error",
        message: "Step execution environment must match the authoritative plan environment",
        stepId: step.id
      });
    }

    if (step.resourceRequirements.data.classification !== plan.scope.dataClass) {
      issues.push({
        code: "DATA_CLASS_NOT_ALLOWED",
        severity: "error",
        message: "Step data classification must match the authoritative plan scope",
        stepId: step.id
      });
    }

    if (
      policy.allowedRegions
      && step.resourceRequirements.data.allowedRegions.length > 0
      && !step.resourceRequirements.data.allowedRegions.some((region) => policy.allowedRegions!.includes(region))
    ) {
      issues.push({
        code: "REGION_NOT_ALLOWED",
        severity: "error",
        message: "Step has no allowed region compatible with policy",
        stepId: step.id
      });
    }

    if (
      policy.minimumReliabilityTier
      && reliabilityRank[step.resourceRequirements.reliability.minimumTier] < reliabilityRank[policy.minimumReliabilityTier]
    ) {
      issues.push({
        code: "RELIABILITY_REQUIREMENT",
        severity: "error",
        message: `Step reliability tier is below required minimum: ${policy.minimumReliabilityTier}`,
        stepId: step.id
      });
    }

    if (
      (policy.fallbackRequiredForProduction && plan.scope.environment === "production")
      || (policy.fallbackRequiredForCustomerData && plan.scope.dataClass === "customer")
    ) {
      if (!step.resourceRequirements.reliability.fallbackRequired) {
        issues.push({
          code: "FALLBACK_REQUIRED",
          severity: "error",
          message: "Fallback is required for this environment/data class",
          stepId: step.id
        });
      }
    }

    if (
      step.resourceRequirements.credentialBindingRequired
      && policy.availableCredentialBindings === false
    ) {
      issues.push({
        code: "CREDENTIAL_BINDING_REQUIRED",
        severity: "error",
        message: "Required credential binding is not available",
        stepId: step.id
      });
    }

    if (
      policy.requireRollbackForRiskAtOrAbove
      && riskRank[step.risk.level] >= riskRank[policy.requireRollbackForRiskAtOrAbove]
      && step.rollback.strategy === "none"
    ) {
      issues.push({
        code: "ROLLBACK_REQUIRED",
        severity: "owner-decision",
        message: "High-risk step requires rollback/mitigation or an explicit owner decision",
        stepId: step.id
      });
    }

    for (const request of step.capabilityRequests) {
      usedCapabilities.add(request.capability);
      if (!declaredCapabilities.has(request.capability)) {
        issues.push({
          code: "CAPABILITY_DECLARATION_MISSING",
          severity: "error",
          message: `Step uses capability not declared by the plan: ${request.capability}`,
          stepId: step.id,
          capability: request.capability
        });
      }
      capabilityIssue(issues, step, request.capability, request.input, getCapability(request.capability));
    }

    const signature = stableJson({
      capabilities: step.capabilityRequests.map((request) => ({
        capability: request.capability,
        input: request.input
      })),
      resourceRequirements: step.resourceRequirements,
      effects: step.effects
    });

    const previous = signatures.get(signature);
    if (previous) {
      issues.push({
        code: "DUPLICATE_WORK",
        severity: "warning",
        message: `Step appears logically equivalent to ${previous}`,
        stepId: step.id
      });
    } else {
      signatures.set(signature, step.id);
    }
  }

  for (const capability of declaredCapabilities) {
    if (!usedCapabilities.has(capability)) {
      issues.push({
        code: "UNUSED_CAPABILITY_DECLARATION",
        severity: "warning",
        message: `Plan declares an unused capability: ${capability}`,
        capability
      });
    }
  }

  const ordering = topologicalOrder(plan.steps);
  if (ordering.hasCycle) {
    issues.push({
      code: "DEPENDENCY_CYCLE",
      severity: "error",
      message: "Plan contains a dependency cycle"
    });
  }

  for (let leftIndex = 0; leftIndex < plan.steps.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < plan.steps.length; rightIndex += 1) {
      const left = plan.steps[leftIndex];
      const right = plan.steps[rightIndex];
      const ordered = dependsTransitively(plan.steps, left.id, right.id)
        || dependsTransitively(plan.steps, right.id, left.id);
      if (ordered) continue;

      const contradiction = left.effects.some((leftEffect) =>
        right.effects.some((rightEffect) => effectsContradict(leftEffect, rightEffect))
      );

      if (contradiction) {
        issues.push({
          code: "CONTRADICTORY_EFFECTS",
          severity: "error",
          message: `Unordered steps ${left.id} and ${right.id} have contradictory effects`
        });
      }
    }
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const ownerDecisions = issues.filter((issue) => issue.severity === "owner-decision");

  return {
    status: errors.length > 0
      ? "invalid"
      : ownerDecisions.length > 0
        ? "owner-decision-required"
        : "valid",
    errors,
    warnings,
    ownerDecisions,
    orderedStepIds: ordering.ordered,
    totalStepCostCents
  };
}


export const PLAN_VALIDATOR_VERSION = "2026-09-21.1";
export const PLAN_VALIDATOR_RULES_HASH = sha256Hex({
  version: PLAN_VALIDATOR_VERSION,
  rules: [
    "trusted-scope",
    "capability-runtime-input",
    "dependency-graph",
    "step-conflicts",
    "effect-conflicts",
    "cost-ceilings",
    "environment-data-region",
    "reliability-fallback",
    "credential-availability",
    "rollback-owner-decision"
  ]
});

export interface PlanValidatorAttestation extends PlanValidationResult {
  planHash: string;
  validationPolicyHash: string;
  validatorVersion: string;
  validatorRulesHash: string;
  attestedAt: string;
  attestationHash: string;
}

export function attestPlanValidation(
  plan: PlanProposal,
  policy: PlanValidationPolicy,
  attestedAt = new Date().toISOString()
): PlanValidatorAttestation {
  const parsed = Date.parse(attestedAt);
  if (!Number.isFinite(parsed)) {
    throw new Error("Plan validator attestation timestamp is invalid");
  }

  const validation = validatePlan(plan, policy);
  const base = {
    ...validation,
    planHash: hashPlan(plan),
    validationPolicyHash: sha256Hex(policy),
    validatorVersion: PLAN_VALIDATOR_VERSION,
    validatorRulesHash: PLAN_VALIDATOR_RULES_HASH,
    attestedAt
  };

  return Object.freeze({
    ...base,
    errors: Object.freeze(validation.errors.map((item) => Object.freeze({ ...item }))),
    warnings: Object.freeze(validation.warnings.map((item) => Object.freeze({ ...item }))),
    ownerDecisions: Object.freeze(validation.ownerDecisions.map((item) => Object.freeze({ ...item }))),
    orderedStepIds: Object.freeze([...validation.orderedStepIds]),
    attestationHash: sha256Hex(base)
  });
}

export function assertPlanValidatorAttestation(
  attestation: PlanValidatorAttestation,
  plan: PlanProposal
) {
  const { attestationHash, ...base } = attestation;
  if (
    sha256Hex(base) !== attestationHash
    || attestation.validatorVersion !== PLAN_VALIDATOR_VERSION
    || attestation.validatorRulesHash !== PLAN_VALIDATOR_RULES_HASH
    || attestation.planHash !== hashPlan(plan)
  ) {
    throw new Error("Plan validator attestation is invalid or stale");
  }
  return attestation;
}
