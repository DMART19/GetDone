import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { KillSwitch } from "@/lib/domain/kill-switch";
import type { CredentialAvailabilitySnapshot } from "@/lib/domain/credential-binding";
import type { ProtectedCapacitySnapshot } from "@/lib/domain/protected-capacity";
import type { BudgetReservation } from "@/lib/domain/budget-reservation";
import type { BudgetPolicy, Guardrail } from "@/lib/domain/objectives";
import { CURRENT_POLICY_VERSION } from "@/lib/domain/policy-registry";
import type { OrchestrationStageHandler } from "@/lib/orchestration/coordinator";
import type { OrchestrationContextBuilder } from "@/lib/orchestration/context-builder";
import type { AIGatewayGovernedPlanner } from "@/lib/orchestration/governed-planner";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import type { OrchestrationPlanningArtifactStore } from "@/lib/orchestration/planning-artifact-store";
import {
  assertContextSnapshotIntegrity,
  assertGovernedPlanArtifactIntegrity,
  assertPlanValidationArtifactIntegrity,
  createPlanValidationArtifact,
  createPolicyBundleArtifact,
  planningArtifactId
} from "@/lib/orchestration/planning-artifacts";
import {
  attestPlanValidation,
  assertPlanValidatorAttestation,
  type PlanValidationPolicy
} from "@/lib/planning/plan-validator";
import type { PlanProposal, PlanStep } from "@/lib/planning/plan-schema";
import { planStepHashes } from "@/lib/planning/plan-hash";
import {
  createPolicySnapshot,
  type PolicyGuardrailSnapshot
} from "@/lib/planning/policy-snapshot";
import {
  evaluateStepPolicy,
  strongestDisposition,
  type PolicyDisposition
} from "@/lib/planning/policy-engine";

export interface OrchestrationValidationConstraints {
  allowedEnvironments: PlanValidationPolicy["allowedEnvironments"];
  allowedDataClasses: PlanValidationPolicy["allowedDataClasses"];
  allowedRegions?: PlanValidationPolicy["allowedRegions"];
  maxPlanCostCents: number;
  maxStepCostCents?: number;
  minimumReliabilityTier?: PlanValidationPolicy["minimumReliabilityTier"];
  fallbackRequiredForProduction?: boolean;
  fallbackRequiredForCustomerData?: boolean;
  requireRollbackForRiskAtOrAbove?: PlanValidationPolicy["requireRollbackForRiskAtOrAbove"];
  availableCredentialBindings?: boolean;
}

export type ValidationConstraintResult =
  | Readonly<{ kind: "ready"; constraints: OrchestrationValidationConstraints }>
  | Readonly<{ kind: "unavailable"; reason: string; retryAt: string }>;

export interface OrchestrationValidationPolicyProvider {
  load(input: {
    run: OrchestrationRun;
    plan: PlanProposal;
  }): Promise<ValidationConstraintResult>;
}

export interface OrchestrationPolicyBudgetEvidence {
  policy: BudgetPolicy;
  currentSpendCents: number;
  reservedCents?: number;
  reservation?: BudgetReservation;
}

export interface OrchestrationPolicyDynamicEvidence {
  region?: string;
  integrationId?: string;
  resourceId?: string;
  poolId?: string;
  providerId?: string;
  failureDomainId?: string;
  workloadClass?: string;
  budget?: OrchestrationPolicyBudgetEvidence;
  guardrails?: {
    scopeId: string;
    policies: readonly Guardrail[];
    metrics: Readonly<Record<string, number | string | boolean | undefined>>;
  };
  killSwitches: readonly KillSwitch[];
  credentialRequirementIds: readonly string[];
  credentialSnapshot?: CredentialAvailabilitySnapshot;
  capacitySnapshot?: ProtectedCapacitySnapshot;
  capacityEvidenceRequired?: boolean;
  fallbackAvailable: boolean;
}

export type PolicyEvidenceResult =
  | Readonly<{ kind: "ready"; evidence: OrchestrationPolicyDynamicEvidence }>
  | Readonly<{ kind: "unavailable"; reason: string; retryAt: string }>;

export interface OrchestrationPolicyEvidenceProvider {
  load(input: {
    run: OrchestrationRun;
    plan: PlanProposal;
    step: PlanStep;
    planHash: string;
    stepHash: string;
  }): Promise<PolicyEvidenceResult>;
}

export class StaticOrchestrationValidationPolicyProvider
implements OrchestrationValidationPolicyProvider {
  constructor(private readonly constraints: OrchestrationValidationConstraints) {}

  async load(): Promise<ValidationConstraintResult> {
    return Object.freeze({
      kind: "ready" as const,
      constraints: Object.freeze({ ...this.constraints })
    });
  }
}

function trustedScope(run: OrchestrationRun): TrustedExecutionScope {
  return Object.freeze({
    userId: run.authorityUserId,
    portfolioId: run.portfolioId,
    companyId: run.companyId,
    environment: run.environment
  });
}

function boundedReason(value: string) {
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 500) : "unspecified";
}

function policyIdempotencyKey(run: OrchestrationRun, planHash: string, stepHash: string) {
  return `orchestration-policy:${run.id}:${planHash.slice(0, 16)}:${stepHash.slice(0, 16)}`;
}

export class GovernedPlanningStageHandler implements OrchestrationStageHandler {
  constructor(
    private readonly artifacts: OrchestrationPlanningArtifactStore,
    private readonly contextBuilder: OrchestrationContextBuilder,
    private readonly planner: AIGatewayGovernedPlanner,
    private readonly validationPolicies: OrchestrationValidationPolicyProvider,
    private readonly policyEvidence: OrchestrationPolicyEvidenceProvider,
    private readonly now: () => Date = () => new Date()
  ) {}

  async advance(run: OrchestrationRun) {
    switch (run.state) {
      case "received":
        return Object.freeze({
          kind: "transition" as const,
          state: "context-building" as const,
          wake: "immediate" as const,
          reason: "begin-authoritative-context-snapshot"
        });

      case "context-building":
        return this.buildContext(run);

      case "planning":
        return this.plan(run);

      case "replan-required":
        return Object.freeze({
          kind: "transition" as const,
          state: "planning" as const,
          wake: "immediate" as const,
          reason: "begin-governed-replan"
        });

      case "validating":
        return this.validate(run);

      case "policy-evaluation":
        return this.evaluatePolicy(run);

      case "awaiting-approval":
      case "policy-cleared":
      case "authorized":
      case "materializing":
      case "queued":
      case "executing":
      case "verifying":
        return Object.freeze({
          kind: "defer" as const,
          retryAt: new Date(this.now().getTime() + 300_000).toISOString(),
          reason: `stage-awaits-external-or-next-tranche:${run.state}`
        });

      case "succeeded":
      case "blocked":
      case "failed":
      case "cancelled":
        throw new ControlPlaneError(
          "CONFLICT",
          `Terminal orchestration state cannot be advanced: ${run.state}`
        );
    }
  }

  private async buildContext(run: OrchestrationRun) {
    const built = await this.contextBuilder.build(run);
    if (built.kind === "unavailable") {
      return Object.freeze({
        kind: "defer" as const,
        retryAt: built.retryAt,
        reason: boundedReason(built.reason)
      });
    }

    await this.artifacts.append(run, {
      kind: "context-snapshot",
      value: built.snapshot
    });

    return Object.freeze({
      kind: "transition" as const,
      state: "planning" as const,
      wake: "immediate" as const,
      reason: `context-snapshot:${built.snapshot.contextHash}`
    });
  }

  private async plan(run: OrchestrationRun) {
    const context = await this.artifacts.latestContext(run);
    if (!context) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Planning requires a persisted context snapshot"
      );
    }
    assertContextSnapshotIntegrity(context);

    const proposed = await this.planner.propose(run, context);
    if (proposed.kind === "unavailable") {
      return Object.freeze({
        kind: "defer" as const,
        retryAt: proposed.retryAt,
        reason: boundedReason(proposed.reason)
      });
    }
    assertGovernedPlanArtifactIntegrity(proposed.artifact);

    await this.artifacts.append(run, {
      kind: "plan-proposal",
      value: proposed.artifact
    });

    return Object.freeze({
      kind: "transition" as const,
      state: "validating" as const,
      wake: "immediate" as const,
      reason: `plan-proposal:${proposed.artifact.planHash}`
    });
  }

  private async validate(run: OrchestrationRun) {
    const planArtifact = await this.artifacts.latestPlan(run);
    if (!planArtifact) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Plan validation requires a persisted governed plan proposal"
      );
    }
    assertGovernedPlanArtifactIntegrity(planArtifact);

    const loaded = await this.validationPolicies.load({
      run,
      plan: planArtifact.plan
    });
    if (loaded.kind === "unavailable") {
      return Object.freeze({
        kind: "defer" as const,
        retryAt: loaded.retryAt,
        reason: boundedReason(loaded.reason)
      });
    }

    const validationPolicy: PlanValidationPolicy = Object.freeze({
      trustedScope: Object.freeze({
        portfolioId: run.portfolioId,
        companyId: run.companyId
      }),
      ...loaded.constraints
    });
    const createdAt = this.now().toISOString();
    const attestation = attestPlanValidation(
      planArtifact.plan,
      validationPolicy,
      createdAt
    );
    assertPlanValidatorAttestation(attestation, planArtifact.plan);

    const artifact = createPlanValidationArtifact({
      id: planningArtifactId({
        kind: "validation-attestation",
        runId: run.id,
        predecessorHash: planArtifact.planHash
      }),
      runId: run.id,
      correlationId: run.correlationId,
      planArtifactId: planArtifact.id,
      planHash: planArtifact.planHash,
      attestation,
      createdAt
    });
    await this.artifacts.append(run, {
      kind: "validation-attestation",
      value: artifact
    });

    if (attestation.status === "invalid") {
      return Object.freeze({
        kind: "transition" as const,
        state: "replan-required" as const,
        wake: "external" as const,
        reason: boundedReason(
          attestation.errors.map((item) => item.code).join(",") || "plan-invalid"
        )
      });
    }

    return Object.freeze({
      kind: "transition" as const,
      state: "policy-evaluation" as const,
      wake: "immediate" as const,
      reason: `validation:${artifact.artifactHash}`
    });
  }

  private async evaluatePolicy(run: OrchestrationRun) {
    const [planArtifact, validationArtifact] = await Promise.all([
      this.artifacts.latestPlan(run),
      this.artifacts.latestValidation(run)
    ]);
    if (!planArtifact || !validationArtifact) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Policy evaluation requires persisted plan and validation evidence"
      );
    }
    assertGovernedPlanArtifactIntegrity(planArtifact);
    assertPlanValidationArtifactIntegrity(validationArtifact);
    assertPlanValidatorAttestation(
      validationArtifact.attestation,
      planArtifact.plan
    );
    if (
      validationArtifact.planHash !== planArtifact.planHash
      || validationArtifact.validationStatus === "invalid"
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Policy evaluation cannot use invalid or mismatched validation evidence"
      );
    }

    const validationConstraintsResult = await this.validationPolicies.load({
      run,
      plan: planArtifact.plan
    });
    if (validationConstraintsResult.kind === "unavailable") {
      return Object.freeze({
        kind: "defer" as const,
        retryAt: validationConstraintsResult.retryAt,
        reason: boundedReason(validationConstraintsResult.reason)
      });
    }

    const currentValidationPolicy: PlanValidationPolicy = Object.freeze({
      trustedScope: Object.freeze({
        portfolioId: run.portfolioId,
        companyId: run.companyId
      }),
      ...validationConstraintsResult.constraints
    });
    if (
      sha256Hex(currentValidationPolicy)
      !== validationArtifact.attestation.validationPolicyHash
    ) {
      return Object.freeze({
        kind: "transition" as const,
        state: "replan-required" as const,
        wake: "external" as const,
        reason: "validation-policy-drift"
      });
    }

    const stepHashes = planStepHashes(planArtifact.plan);
    const byStepId = new Map(planArtifact.plan.steps.map((step) => [step.id, step]));
    const ordered = validationArtifact.attestation.orderedStepIds
      .map((id) => byStepId.get(id))
      .filter((step): step is PlanStep => Boolean(step));

    let disposition: PolicyDisposition =
      validationArtifact.validationStatus === "owner-decision-required"
        ? "APPROVAL_REQUIRED"
        : "AUTO";
    const stepPolicies = [];

    for (const step of ordered) {
      const stepHash = stepHashes[step.id];
      if (!stepHash) {
        throw new ControlPlaneError("CONFLICT", "Validated plan is missing a step hash");
      }

      const loaded = await this.policyEvidence.load({
        run,
        plan: planArtifact.plan,
        step,
        planHash: planArtifact.planHash,
        stepHash
      });
      if (loaded.kind === "unavailable") {
        return Object.freeze({
          kind: "defer" as const,
          retryAt: loaded.retryAt,
          reason: boundedReason(loaded.reason)
        });
      }

      const evidence = loaded.evidence;
      const capacityEvidenceRequired = Boolean(
        evidence.capacityEvidenceRequired
        || evidence.resourceId
        || evidence.poolId
        || step.resourceRequirements.compute
      );
      if (capacityEvidenceRequired && !evidence.capacitySnapshot) {
        return Object.freeze({
          kind: "defer" as const,
          retryAt: new Date(this.now().getTime() + 30_000).toISOString(),
          reason: `protected-capacity-evidence-unavailable:${step.id}`
        });
      }
      if (
        step.resourceRequirements.credentialBindingRequired
        && evidence.credentialRequirementIds.length === 0
      ) {
        return Object.freeze({
          kind: "defer" as const,
          retryAt: new Date(this.now().getTime() + 30_000).toISOString(),
          reason: `credential-requirement-evidence-unavailable:${step.id}`
        });
      }

      const createdAt = this.now().toISOString();
      const snapshot = createPolicySnapshot({
        id: `policy-snapshot:${run.id}:${step.id}:${stepHash.slice(0, 16)}`,
        policyVersion: CURRENT_POLICY_VERSION,
        scope: trustedScope(run),
        planHash: planArtifact.planHash,
        stepHash,
        capabilityNames: step.capabilityRequests.map((request) => request.capability),
        dataClass: planArtifact.plan.scope.dataClass,
        region: evidence.region,
        allowedEnvironments: validationConstraintsResult.constraints.allowedEnvironments,
        allowedDataClasses: validationConstraintsResult.constraints.allowedDataClasses,
        allowedRegions: validationConstraintsResult.constraints.allowedRegions,
        integrationId: evidence.integrationId,
        resourceId: evidence.resourceId,
        poolId: evidence.poolId,
        providerId: evidence.providerId,
        failureDomainId: evidence.failureDomainId,
        workloadClass: evidence.workloadClass,
        budget: evidence.budget ? {
          policy: evidence.budget.policy,
          currentSpendCents: evidence.budget.currentSpendCents,
          reservedCents: evidence.budget.reservedCents,
          requestedCostCents: step.estimatedCostCents
        } : undefined,
        budgetReservation: evidence.budget?.reservation,
        guardrails: evidence.guardrails as PolicyGuardrailSnapshot | undefined,
        killSwitches: evidence.killSwitches,
        credentialRequirementIds: evidence.credentialRequirementIds,
        credentialSnapshot: evidence.credentialSnapshot,
        capacitySnapshot: evidence.capacitySnapshot,
        capacityEvidenceRequired,
        fallbackRequired: step.resourceRequirements.reliability.fallbackRequired,
        fallbackAvailable: evidence.fallbackAvailable,
        idempotencyKey: policyIdempotencyKey(run, planArtifact.planHash, stepHash),
        resourceRequirements: step.resourceRequirements,
        createdAt
      });

      const evaluation = evaluateStepPolicy({
        authenticated: true,
        scopeResolved: true,
        trustedScope: snapshot.scope,
        capabilities: snapshot.capabilityNames,
        planHash: snapshot.planHash,
        stepHash: snapshot.stepHash,
        environment: run.environment,
        dataClass: snapshot.dataClass,
        region: snapshot.region,
        allowedEnvironments: snapshot.allowedEnvironments,
        allowedDataClasses: snapshot.allowedDataClasses,
        allowedRegions: snapshot.allowedRegions,
        integrationId: snapshot.integrationId,
        resourceId: snapshot.resourceId,
        poolId: snapshot.poolId,
        providerId: snapshot.providerId,
        failureDomainId: snapshot.failureDomainId,
        workloadClass: snapshot.workloadClass,
        credentialRequirementIds: snapshot.credentialRequirementIds,
        credentialSnapshot: snapshot.credentialSnapshot,
        capacitySnapshot: snapshot.capacitySnapshot,
        capacityEvidenceRequired: snapshot.capacityEvidenceRequired,
        fallbackRequired: snapshot.fallbackRequired,
        fallbackAvailable: snapshot.fallbackAvailable,
        idempotencyKey: snapshot.idempotencyKey,
        killSwitches: snapshot.killSwitches,
        budget: snapshot.budget,
        budgetReservation: snapshot.budgetReservation,
        guardrails: snapshot.guardrails,
        now: Date.parse(createdAt)
      });

      disposition = strongestDisposition(disposition, evaluation.disposition);
      stepPolicies.push(Object.freeze({
        stepId: step.id,
        stepHash,
        snapshot,
        evaluation
      }));
    }

    const createdAt = this.now().toISOString();
    const bundle = createPolicyBundleArtifact({
      id: planningArtifactId({
        kind: "policy-bundle",
        runId: run.id,
        predecessorHash: validationArtifact.attestation.attestationHash
      }),
      runId: run.id,
      correlationId: run.correlationId,
      planArtifactId: planArtifact.id,
      planHash: planArtifact.planHash,
      validationArtifactId: validationArtifact.id,
      validationAttestationHash: validationArtifact.attestation.attestationHash,
      strongestDisposition: disposition,
      ownerDecisionRequired:
        validationArtifact.validationStatus === "owner-decision-required",
      stepPolicies,
      createdAt
    });
    await this.artifacts.append(run, {
      kind: "policy-bundle",
      value: bundle
    });

    if (disposition === "BLOCKED") {
      return Object.freeze({
        kind: "transition" as const,
        state: "blocked" as const,
        wake: "external" as const,
        reason: "policy-blocked"
      });
    }

    if (disposition === "APPROVAL_REQUIRED" || disposition === "STRONG_APPROVAL") {
      return Object.freeze({
        kind: "transition" as const,
        state: "awaiting-approval" as const,
        wake: "external" as const,
        reason: `policy:${disposition.toLowerCase()}`
      });
    }

    return Object.freeze({
      kind: "transition" as const,
      state: "policy-cleared" as const,
      wake: "external" as const,
      reason: "policy-cleared-without-authorization-grant"
    });
  }
}
