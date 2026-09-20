import type { GetDoneEnvironment } from "@/lib/control-plane/request-context";
import { getCapability, type CapabilityDefinition } from "@/lib/domain/capabilities";
import { blockingKillSwitches, type KillSwitch } from "@/lib/domain/kill-switch";
import {
  evaluateBudget,
  evaluateGuardrails,
  type BudgetPolicy,
  type Guardrail
} from "@/lib/domain/objectives";

export type PolicyDisposition =
  | "AUTO"
  | "APPROVAL_REQUIRED"
  | "STRONG_APPROVAL"
  | "BLOCKED";

export interface TrustedPolicyScope {
  portfolioId: string;
  companyId: string;
}

export interface PolicyEvaluationInput {
  authenticated: boolean;
  scopeResolved: boolean;
  trustedScope: TrustedPolicyScope;
  capability: string;
  environment: GetDoneEnvironment;
  dataClass: "public" | "internal" | "customer" | "sensitive";
  region?: string;
  allowedEnvironments: readonly GetDoneEnvironment[];
  allowedDataClasses: readonly ("public" | "internal" | "customer" | "sensitive")[];
  allowedRegions?: readonly string[];
  credentialBindingAvailable: boolean;
  credentialBindingRequired: boolean;
  protectedHeadroomSatisfied: boolean;
  fallbackRequired: boolean;
  fallbackAvailable: boolean;
  idempotencyKey?: string;
  killSwitches: readonly KillSwitch[];
  budget?: {
    policy: BudgetPolicy;
    currentSpendCents: number;
    reservedCents?: number;
    requestedCostCents: number;
  };
  guardrails?: {
    scopeId?: string;
    policies: readonly Guardrail[];
    metrics: Readonly<Record<string, number | string | boolean | undefined>>;
  };
  approvalGranted?: boolean;
  freshStepUpSatisfied?: boolean;
}

export interface PolicyReason {
  code:
    | "UNAUTHENTICATED"
    | "UNRESOLVED_SCOPE"
    | "UNKNOWN_CAPABILITY"
    | "CAPABILITY_BLOCKED"
    | "ENVIRONMENT_BLOCKED"
    | "DATA_CLASS_BLOCKED"
    | "REGION_BLOCKED"
    | "CREDENTIAL_MISSING"
    | "HEADROOM_BLOCKED"
    | "FALLBACK_MISSING"
    | "IDEMPOTENCY_MISSING"
    | "KILL_SWITCH"
    | "BUDGET_BLOCKED"
    | "BUDGET_APPROVAL"
    | "GUARDRAIL_BLOCKED"
    | "GUARDRAIL_APPROVAL"
    | "CAPABILITY_APPROVAL"
    | "CAPABILITY_STRONG_APPROVAL";
  message: string;
}

export interface PolicyEvaluation {
  disposition: PolicyDisposition;
  reasons: readonly PolicyReason[];
  capability?: CapabilityDefinition;
  requiresFreshStepUp: boolean;
  approvalSatisfied: boolean;
  readyForTaskGeneration: boolean;
}

const dispositionRank: Record<PolicyDisposition, number> = {
  AUTO: 0,
  APPROVAL_REQUIRED: 1,
  STRONG_APPROVAL: 2,
  BLOCKED: 3
};

function strongest(left: PolicyDisposition, right: PolicyDisposition): PolicyDisposition {
  return dispositionRank[right] > dispositionRank[left] ? right : left;
}

function capabilityDisposition(capability: CapabilityDefinition): PolicyDisposition {
  if (capability.approval === "blocked") return "BLOCKED";
  if (capability.approval === "strong-approval") return "STRONG_APPROVAL";
  if (capability.approval === "approval") return "APPROVAL_REQUIRED";
  return "AUTO";
}

export function evaluatePolicy(input: PolicyEvaluationInput): PolicyEvaluation {
  const reasons: PolicyReason[] = [];
  let disposition: PolicyDisposition = "AUTO";

  const block = (code: PolicyReason["code"], message: string) => {
    disposition = "BLOCKED";
    reasons.push({ code, message });
  };

  if (!input.authenticated) block("UNAUTHENTICATED", "Authenticated actor/system identity is required");
  if (!input.scopeResolved) block("UNRESOLVED_SCOPE", "Trusted portfolio/company scope must be resolved server-side");

  const capability = getCapability(input.capability);
  if (!capability || !capability.enabled) {
    block("UNKNOWN_CAPABILITY", `Capability is unavailable: ${input.capability}`);
  } else {
    const required = capabilityDisposition(capability);
    disposition = strongest(disposition, required);
    if (required === "BLOCKED") {
      reasons.push({ code: "CAPABILITY_BLOCKED", message: "Capability policy is explicitly blocked" });
    } else if (required === "STRONG_APPROVAL") {
      reasons.push({ code: "CAPABILITY_STRONG_APPROVAL", message: "Capability requires strong approval" });
    } else if (required === "APPROVAL_REQUIRED") {
      reasons.push({ code: "CAPABILITY_APPROVAL", message: "Capability requires approval" });
    }
  }

  if (!input.allowedEnvironments.includes(input.environment)) {
    block("ENVIRONMENT_BLOCKED", `Environment is not permitted: ${input.environment}`);
  }

  if (!input.allowedDataClasses.includes(input.dataClass)) {
    block("DATA_CLASS_BLOCKED", `Data class is not permitted: ${input.dataClass}`);
  }

  if (input.allowedRegions && input.region && !input.allowedRegions.includes(input.region)) {
    block("REGION_BLOCKED", `Region is not permitted: ${input.region}`);
  }

  if (input.credentialBindingRequired && !input.credentialBindingAvailable) {
    block("CREDENTIAL_MISSING", "Required credential binding is unavailable");
  }

  if (!input.protectedHeadroomSatisfied) {
    block("HEADROOM_BLOCKED", "Protected capacity/headroom requirement is not satisfied");
  }

  if (input.fallbackRequired && !input.fallbackAvailable) {
    block("FALLBACK_MISSING", "Required fallback is unavailable");
  }

  if (!input.idempotencyKey) {
    block("IDEMPOTENCY_MISSING", "Idempotency key is required before authorization");
  }

  const killSwitches = blockingKillSwitches(input.killSwitches, {
    portfolioId: input.trustedScope.portfolioId,
    companyId: input.trustedScope.companyId,
    capability: input.capability
  });
  if (killSwitches.length > 0) {
    block("KILL_SWITCH", `Applicable kill switch blocks new work: ${killSwitches.map((item) => item.id).join(", ")}`);
  }

  if (input.budget) {
    const budget = evaluateBudget(input.budget.policy, {
      scopeId: input.budget.policy.scopeId,
      currentSpendCents: input.budget.currentSpendCents,
      reservedCents: input.budget.reservedCents,
      requestedCostCents: input.budget.requestedCostCents
    });

    if (budget.disposition === "blocked") {
      block("BUDGET_BLOCKED", budget.reason ?? "Budget policy blocked the action");
    } else if (budget.disposition === "approval-required") {
      disposition = strongest(disposition, "APPROVAL_REQUIRED");
      reasons.push({ code: "BUDGET_APPROVAL", message: budget.reason ?? "Budget threshold requires approval" });
    }
  }

  if (input.guardrails) {
    const guardrails = evaluateGuardrails(
      input.guardrails.policies,
      input.guardrails.scopeId ?? input.trustedScope.companyId,
      input.guardrails.metrics
    );

    if (guardrails.disposition === "blocked") {
      block("GUARDRAIL_BLOCKED", "Protected guardrail violation blocks the action");
    } else if (guardrails.disposition === "approval-required") {
      disposition = strongest(disposition, "APPROVAL_REQUIRED");
      reasons.push({ code: "GUARDRAIL_APPROVAL", message: "Guardrail exception requires approval" });
    }
  }

  const requiresFreshStepUp = disposition === "STRONG_APPROVAL";
  const approvalSatisfied = disposition === "AUTO"
    || (disposition === "APPROVAL_REQUIRED" && input.approvalGranted === true)
    || (
      disposition === "STRONG_APPROVAL"
      && input.approvalGranted === true
      && input.freshStepUpSatisfied === true
    );

  return {
    disposition,
    reasons,
    capability,
    requiresFreshStepUp,
    approvalSatisfied,
    readyForTaskGeneration: disposition !== "BLOCKED" && approvalSatisfied
  };
}
