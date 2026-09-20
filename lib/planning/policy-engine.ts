import type { GetDoneEnvironment } from "@/lib/control-plane/request-context";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { getCapability, type CapabilityDefinition } from "@/lib/domain/capabilities";
import { blockingKillSwitches, type KillSwitch } from "@/lib/domain/kill-switch";
import {
  evaluateBudget,
  evaluateGuardrails,
  type BudgetPolicy,
  type Guardrail
} from "@/lib/domain/objectives";
import {
  evaluateCredentialAvailability,
  type CredentialAvailabilitySnapshot
} from "@/lib/domain/credential-binding";
import {
  assertBudgetReservation,
  type BudgetReservation
} from "@/lib/domain/budget-reservation";
import {
  assertProtectedCapacitySnapshot,
  type ProtectedCapacitySnapshot
} from "@/lib/domain/protected-capacity";
import {
  assertApprovalProof,
  type ApprovalProof,
  type StepUpProof
} from "@/lib/authorization/proofs";

export type PolicyDisposition =
  | "AUTO"
  | "APPROVAL_REQUIRED"
  | "STRONG_APPROVAL"
  | "BLOCKED";

export const POLICY_ENGINE_VERSION = "2026-09-20.2";
export const POLICY_PRECEDENCE: readonly PolicyDisposition[] = Object.freeze([
  "AUTO",
  "APPROVAL_REQUIRED",
  "STRONG_APPROVAL",
  "BLOCKED"
]);
export const POLICY_RULES_HASH = sha256Hex({
  version: POLICY_ENGINE_VERSION,
  precedence: POLICY_PRECEDENCE,
  rules: [
    "identity-and-scope",
    "capability-approval",
    "environment-data-region",
    "credential-snapshot",
    "protected-capacity-snapshot",
    "fallback",
    "idempotency",
    "all-kill-switch-scopes",
    "budget-reservation",
    "guardrails",
    "approval-proof",
    "strong-step-up-proof"
  ]
});

export interface PolicyEvaluationInput {
  authenticated: boolean;
  scopeResolved: boolean;
  trustedScope: TrustedExecutionScope;
  capability: string;
  planHash: string;
  stepHash: string;
  environment: GetDoneEnvironment;
  dataClass: "public" | "internal" | "customer" | "sensitive";
  region?: string;
  allowedEnvironments: readonly GetDoneEnvironment[];
  allowedDataClasses: readonly ("public" | "internal" | "customer" | "sensitive")[];
  allowedRegions?: readonly string[];

  integrationId?: string;
  resourceId?: string;
  poolId?: string;
  providerId?: string;
  failureDomainId?: string;
  workloadClass?: string;

  credentialRequirementIds: readonly string[];
  credentialSnapshot?: CredentialAvailabilitySnapshot;
  capacitySnapshot?: ProtectedCapacitySnapshot;

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
  budgetReservation?: BudgetReservation;

  guardrails?: {
    scopeId?: string;
    policies: readonly Guardrail[];
    metrics: Readonly<Record<string, number | string | boolean | undefined>>;
  };

  approvalProof?: ApprovalProof;
  stepUpProof?: StepUpProof;
  now?: number;
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
    | "CREDENTIAL_SNAPSHOT_INVALID"
    | "HEADROOM_BLOCKED"
    | "CAPACITY_SNAPSHOT_INVALID"
    | "FALLBACK_MISSING"
    | "IDEMPOTENCY_MISSING"
    | "KILL_SWITCH"
    | "BUDGET_BLOCKED"
    | "BUDGET_APPROVAL"
    | "BUDGET_RESERVATION_MISSING"
    | "BUDGET_RESERVATION_INVALID"
    | "GUARDRAIL_BLOCKED"
    | "GUARDRAIL_APPROVAL"
    | "CAPABILITY_APPROVAL"
    | "CAPABILITY_STRONG_APPROVAL"
    | "APPROVAL_PROOF_INVALID"
    | "STEP_UP_PROOF_INVALID";
  message: string;
}

export interface PolicyEvaluation {
  disposition: PolicyDisposition;
  reasons: readonly PolicyReason[];
  capability?: CapabilityDefinition;
  policyEngineVersion: string;
  policyRulesHash: string;
  requiresFreshStepUp: boolean;
  approvalSatisfied: boolean;
  readyForTaskGeneration: boolean;
}

export interface StepPolicyEvaluation {
  disposition: PolicyDisposition;
  reasons: readonly PolicyReason[];
  capabilityEvaluations: Readonly<Record<string, PolicyEvaluation>>;
  policyEngineVersion: string;
  policyRulesHash: string;
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

export function strongestDisposition(
  left: PolicyDisposition,
  right: PolicyDisposition
): PolicyDisposition {
  return dispositionRank[right] > dispositionRank[left] ? right : left;
}

function capabilityDisposition(capability: CapabilityDefinition): PolicyDisposition {
  if (capability.approval === "blocked") return "BLOCKED";
  if (capability.approval === "strong-approval") return "STRONG_APPROVAL";
  if (capability.approval === "approval") return "APPROVAL_REQUIRED";
  return "AUTO";
}

function proofSatisfied(
  disposition: PolicyDisposition,
  input: PolicyEvaluationInput,
  reasons: PolicyReason[]
) {
  if (disposition === "AUTO") return true;
  if (disposition === "BLOCKED") return false;

  if (!input.approvalProof) {
    reasons.push({
      code: "APPROVAL_PROOF_INVALID",
      message: "A matching approval proof is required"
    });
    return false;
  }

  try {
    assertApprovalProof(input.approvalProof, {
      scope: input.trustedScope,
      planHash: input.planHash,
      stepHash: input.stepHash,
      requiredLevel: disposition === "STRONG_APPROVAL" ? "strong-approval" : "approval",
      now: input.now,
      stepUpProof: input.stepUpProof
    });
  } catch {
    reasons.push({
      code: disposition === "STRONG_APPROVAL" && !input.stepUpProof
        ? "STEP_UP_PROOF_INVALID"
        : "APPROVAL_PROOF_INVALID",
      message: disposition === "STRONG_APPROVAL"
        ? "Strong approval requires matching fresh approval and step-up proofs"
        : "Approval proof is missing, expired, tampered, or does not match this plan step"
    });
    return false;
  }

  return true;
}

export function evaluatePolicy(input: PolicyEvaluationInput): PolicyEvaluation {
  const reasons: PolicyReason[] = [];
  let disposition: PolicyDisposition = "AUTO";
  const now = input.now ?? Date.now();

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
    disposition = strongestDisposition(disposition, required);
    if (required === "BLOCKED") {
      reasons.push({ code: "CAPABILITY_BLOCKED", message: "Capability policy is explicitly blocked" });
    } else if (required === "STRONG_APPROVAL") {
      reasons.push({ code: "CAPABILITY_STRONG_APPROVAL", message: "Capability requires strong approval" });
    } else if (required === "APPROVAL_REQUIRED") {
      reasons.push({ code: "CAPABILITY_APPROVAL", message: "Capability requires approval" });
    }
  }

  if (input.environment !== input.trustedScope.environment) {
    block("ENVIRONMENT_BLOCKED", "Policy environment does not match trusted execution scope");
  } else if (!input.allowedEnvironments.includes(input.environment)) {
    block("ENVIRONMENT_BLOCKED", `Environment is not permitted: ${input.environment}`);
  }

  if (!input.allowedDataClasses.includes(input.dataClass)) {
    block("DATA_CLASS_BLOCKED", `Data class is not permitted: ${input.dataClass}`);
  }

  if (input.allowedRegions && input.region && !input.allowedRegions.includes(input.region)) {
    block("REGION_BLOCKED", `Region is not permitted: ${input.region}`);
  }

  if (input.credentialRequirementIds.length > 0) {
    if (!input.credentialSnapshot) {
      block("CREDENTIAL_MISSING", "Credential requirements exist but no credential availability snapshot was supplied");
    } else {
      try {
        const knownRequirements = new Set(input.credentialSnapshot.requirements.map((item) => item.id));
        if (input.credentialRequirementIds.some((id) => !knownRequirements.has(id))) {
          block("CREDENTIAL_MISSING", "Credential snapshot does not contain all required credential requirements");
        } else {
          const result = evaluateCredentialAvailability(input.credentialSnapshot, {
            scope: input.trustedScope,
            capabilities: [input.capability],
            now
          });
          if (!result.satisfied) {
            block("CREDENTIAL_MISSING", `Required credential bindings are unavailable: ${result.missingRequirementIds.join(", ")}`);
          }
        }
      } catch {
        block("CREDENTIAL_SNAPSHOT_INVALID", "Credential availability snapshot is stale, tampered, or out of scope");
      }
    }
  }

  if (input.capacitySnapshot) {
    try {
      assertProtectedCapacitySnapshot({
        snapshot: input.capacitySnapshot,
        scope: input.trustedScope,
        resourceId: input.resourceId ?? input.trustedScope.resourceId,
        poolId: input.poolId,
        now
      });
    } catch {
      block("CAPACITY_SNAPSHOT_INVALID", "Protected capacity snapshot is stale, tampered, out of scope, or lacks required headroom");
    }
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
    integrationId: input.integrationId,
    capability: input.capability,
    resourceId: input.resourceId ?? input.trustedScope.resourceId,
    poolId: input.poolId,
    providerId: input.providerId,
    failureDomainId: input.failureDomainId,
    workloadClass: input.workloadClass
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
    } else {
      if (input.budget.requestedCostCents > 0) {
        if (!input.budgetReservation) {
          block("BUDGET_RESERVATION_MISSING", "Budgeted work requires a bound budget reservation");
        } else {
          try {
            assertBudgetReservation({
              reservation: input.budgetReservation,
              scope: input.trustedScope,
              planHash: input.planHash,
              stepHash: input.stepHash,
              minimumAmountCents: input.budget.requestedCostCents,
              now
            });
          } catch {
            block("BUDGET_RESERVATION_INVALID", "Budget reservation is stale, tampered, out of scope, or insufficient");
          }
        }
      }

      if (budget.disposition === "approval-required") {
        disposition = strongestDisposition(disposition, "APPROVAL_REQUIRED");
        reasons.push({ code: "BUDGET_APPROVAL", message: budget.reason ?? "Budget threshold requires approval" });
      }
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
      disposition = strongestDisposition(disposition, "APPROVAL_REQUIRED");
      reasons.push({ code: "GUARDRAIL_APPROVAL", message: "Guardrail exception requires approval" });
    }
  }

  const requiresFreshStepUp = disposition === "STRONG_APPROVAL";
  const approvalSatisfied = proofSatisfied(disposition, input, reasons);

  return {
    disposition,
    reasons,
    capability,
    policyEngineVersion: POLICY_ENGINE_VERSION,
    policyRulesHash: POLICY_RULES_HASH,
    requiresFreshStepUp,
    approvalSatisfied,
    readyForTaskGeneration: disposition !== "BLOCKED" && approvalSatisfied
  };
}

export function evaluateStepPolicy(
  input: Omit<PolicyEvaluationInput, "capability"> & { capabilities: readonly string[] }
): StepPolicyEvaluation {
  const capabilityEvaluations: Record<string, PolicyEvaluation> = {};
  let disposition: PolicyDisposition = "AUTO";
  const reasons: PolicyReason[] = [];

  for (const capability of [...new Set(input.capabilities)].sort()) {
    const evaluation = evaluatePolicy({ ...input, capability });
    capabilityEvaluations[capability] = evaluation;
    disposition = strongestDisposition(disposition, evaluation.disposition);
    reasons.push(...evaluation.reasons);
  }

  const dedupedReasons = reasons.filter((reason, index, all) =>
    all.findIndex((candidate) => candidate.code === reason.code && candidate.message === reason.message) === index
  );

  const readyForTaskGeneration =
    disposition !== "BLOCKED"
    && Object.values(capabilityEvaluations).every((evaluation) => evaluation.readyForTaskGeneration);

  return Object.freeze({
    disposition,
    reasons: Object.freeze(dedupedReasons),
    capabilityEvaluations: Object.freeze(capabilityEvaluations),
    policyEngineVersion: POLICY_ENGINE_VERSION,
    policyRulesHash: POLICY_RULES_HASH,
    requiresFreshStepUp: disposition === "STRONG_APPROVAL",
    approvalSatisfied: readyForTaskGeneration,
    readyForTaskGeneration
  });
}
