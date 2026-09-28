import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  issueAuthorizationGrant,
  type AuthorizationGrant
} from "@/lib/authorization/grants";
import type { AuthoritativeDecision } from "@/lib/domain/decision-service";
import type { ApprovalRecord } from "@/lib/domain/services/approval-service";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import type { OrchestrationExecutionArtifactStore } from "@/lib/orchestration/execution-artifact-store";
import {
  createAuthorizationBundleExecutionArtifact,
  createValidationReceiptExecutionArtifact,
  executionArtifactId
} from "@/lib/orchestration/execution-artifacts";
import type { OrchestrationPlanningArtifactStore } from "@/lib/orchestration/planning-artifact-store";
import {
  assertGovernedPlanArtifactIntegrity,
  assertPlanValidationArtifactIntegrity,
  assertPolicyBundleArtifactIntegrity
} from "@/lib/orchestration/planning-artifacts";
import type {
  OrchestrationPolicyEvidenceProvider,
  OrchestrationValidationPolicyProvider
} from "@/lib/orchestration/governed-planning-stage-handler";
import {
  createPolicySnapshot
} from "@/lib/planning/policy-snapshot";
import {
  evaluateStepPolicy
} from "@/lib/planning/policy-engine";
import {
  createValidationReceipt,
  createValidationSnapshot,
  type ValidationEvidenceReference
} from "@/lib/planning/validation-receipt";

export interface GovernedDecisionApprovalReader {
  getDecision(id: string): Promise<AuthoritativeDecision | null>;
  getApproval(id: string): Promise<ApprovalRecord | null>;
}

export interface AuthorizationGrantWriter {
  insert(grant: AuthorizationGrant): Promise<void>;
  get(id: string): Promise<AuthorizationGrant | null>;
}

export type AuthorizationValidationEvidenceResult =
  | Readonly<{
      kind: "ready";
      configurationVersion: string;
      healthReference?: ValidationEvidenceReference;
      expiresAt?: string;
    }>
  | Readonly<{ kind: "unavailable"; reason: string; retryAt: string }>;

export interface AuthorizationValidationEvidenceProvider {
  load(input: {
    run: OrchestrationRun;
    planHash: string;
  }): Promise<AuthorizationValidationEvidenceResult>;
}

export interface GovernedAuthorizationIssuerConfig {
  validationReceiptTtlMs?: number;
  grantTtlMs?: number;
}

export type GovernedAuthorizationResult =
  | Readonly<{ kind: "authorized"; grants: readonly AuthorizationGrant[] }>
  | Readonly<{ kind: "awaiting-approval"; reason: string }>
  | Readonly<{ kind: "blocked"; reason: string }>
  | Readonly<{ kind: "replan-required"; reason: string }>
  | Readonly<{ kind: "defer"; reason: string; retryAt: string }>;

function decisionId(runId: string, stepHash: string) {
  return `decision:orchestration:${sha256Hex({
    runId,
    stepHash
  })}`;
}

function approvalId(runId: string, stepHash: string) {
  return `approval:orchestration:${sha256Hex({
    runId,
    stepHash
  })}`;
}

function minimumTimestamp(values: readonly (string | undefined)[]) {
  const parsed = values
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return parsed.length > 0 ? Math.min(...parsed) : undefined;
}

function aggregateReference(
  prefix: string,
  entries: readonly { id: string; hash: string; observedAt?: string; expiresAt?: string }[]
): ValidationEvidenceReference | undefined {
  if (entries.length === 0) return undefined;
  const observed = entries
    .map((entry) => entry.observedAt ? Date.parse(entry.observedAt) : undefined)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  const expires = minimumTimestamp(entries.map((entry) => entry.expiresAt));
  return Object.freeze({
    id: prefix,
    hash: sha256Hex(entries.map((entry) => ({
      id: entry.id,
      hash: entry.hash
    }))),
    observedAt: observed.length > 0
      ? new Date(Math.max(...observed)).toISOString()
      : undefined,
    expiresAt: expires !== undefined ? new Date(expires).toISOString() : undefined
  });
}

export class GovernedAuthorizationIssuer {
  constructor(
    private readonly planning: OrchestrationPlanningArtifactStore,
    private readonly execution: OrchestrationExecutionArtifactStore,
    private readonly decisions: GovernedDecisionApprovalReader,
    private readonly validationPolicies: OrchestrationValidationPolicyProvider,
    private readonly policyEvidence: OrchestrationPolicyEvidenceProvider,
    private readonly validationEvidence: AuthorizationValidationEvidenceProvider,
    private readonly grants: AuthorizationGrantWriter,
    private readonly config: GovernedAuthorizationIssuerConfig = {},
    private readonly now: () => Date = () => new Date()
  ) {}

  async authorize(run: OrchestrationRun): Promise<GovernedAuthorizationResult> {
    const [planArtifact, validationArtifact, policyBundle] = await Promise.all([
      this.planning.latestPlan(run),
      this.planning.latestValidation(run),
      this.planning.latestPolicy(run)
    ]);

    if (!planArtifact || !validationArtifact || !policyBundle) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Authorization requires persisted plan, validation, and policy artifacts"
      );
    }
    assertGovernedPlanArtifactIntegrity(planArtifact);
    assertPlanValidationArtifactIntegrity(validationArtifact);
    assertPolicyBundleArtifactIntegrity(policyBundle);

    if (
      validationArtifact.validationStatus !== "valid"
      || validationArtifact.attestation.errors.length > 0
      || validationArtifact.attestation.ownerDecisions.length > 0
    ) {
      return Object.freeze({
        kind: "replan-required" as const,
        reason: "validation-is-not-clean-for-authorization"
      });
    }

    const currentConstraints = await this.validationPolicies.load({
      run,
      plan: planArtifact.plan
    });
    if (currentConstraints.kind === "unavailable") {
      return Object.freeze({
        kind: "defer" as const,
        reason: currentConstraints.reason,
        retryAt: currentConstraints.retryAt
      });
    }

    const currentValidationPolicy = Object.freeze({
      trustedScope: Object.freeze({
        portfolioId: run.portfolioId,
        companyId: run.companyId
      }),
      ...currentConstraints.constraints
    });
    if (
      sha256Hex(currentValidationPolicy)
      !== validationArtifact.attestation.validationPolicyHash
    ) {
      return Object.freeze({
        kind: "replan-required" as const,
        reason: "validation-policy-changed-before-authorization"
      });
    }

    const stepEvidence = [];
    const capacityReferences: Array<{
      id: string;
      hash: string;
      observedAt?: string;
      expiresAt?: string;
    }> = [];
    const credentialReferences: Array<{
      id: string;
      hash: string;
      observedAt?: string;
      expiresAt?: string;
    }> = [];

    for (const prior of policyBundle.stepPolicies) {
      const step = planArtifact.plan.steps.find((candidate) => candidate.id === prior.stepId);
      if (!step) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          `Policy step is absent from current plan: ${prior.stepId}`
        );
      }

      let approvalProof;
      let stepUpProof;

      if (
        prior.evaluation.disposition === "APPROVAL_REQUIRED"
        || prior.evaluation.disposition === "STRONG_APPROVAL"
      ) {
        const decision = await this.decisions.getDecision(
          decisionId(run.id, prior.stepHash)
        );
        const approval = await this.decisions.getApproval(
          approvalId(run.id, prior.stepHash)
        );

        if (!decision || !approval) {
          return Object.freeze({
            kind: "awaiting-approval" as const,
            reason: `decision-approval-not-materialized:${prior.stepId}`
          });
        }
        if (decision.status === "rejected" || decision.status === "modified") {
          return Object.freeze({
            kind: "blocked" as const,
            reason: `owner-decision-${decision.status}:${prior.stepId}`
          });
        }
        if (decision.status !== "approved" || approval.state !== "granted") {
          return Object.freeze({
            kind: "awaiting-approval" as const,
            reason: `approval-pending:${prior.stepId}`
          });
        }
        if (
          decision.orchestrationRunId !== run.id
          || decision.planHash !== planArtifact.planHash
          || decision.stepHash !== prior.stepHash
          || decision.approvalId !== approval.id
          || approval.decisionId !== decision.id
          || !approval.approvalProof
          || approval.approvalProof.proofHash !== decision.approvalProofHash
        ) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Decision/Approval exact-hash lineage does not match the governed step"
          );
        }

        approvalProof = approval.approvalProof;
        stepUpProof = approval.stepUpProof;
      }

      const loaded = await this.policyEvidence.load({
        run,
        plan: planArtifact.plan,
        step,
        planHash: planArtifact.planHash,
        stepHash: prior.stepHash
      });
      if (loaded.kind === "unavailable") {
        return Object.freeze({
          kind: "defer" as const,
          reason: loaded.reason,
          retryAt: loaded.retryAt
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
          reason: `protected-capacity-evidence-unavailable:${step.id}`,
          retryAt: new Date(this.now().getTime() + 30_000).toISOString()
        });
      }

      const createdAt = this.now().toISOString();
      const snapshot = createPolicySnapshot({
        id: `policy-snapshot:authorization:${run.id}:${step.id}:${prior.stepHash.slice(0, 16)}`,
        policyVersion: prior.snapshot.policyVersion,
        scope: prior.snapshot.scope,
        planHash: planArtifact.planHash,
        stepHash: prior.stepHash,
        capabilityNames: step.capabilityRequests.map((request) => request.capability),
        dataClass: planArtifact.plan.scope.dataClass,
        region: evidence.region,
        allowedEnvironments: currentConstraints.constraints.allowedEnvironments,
        allowedDataClasses: currentConstraints.constraints.allowedDataClasses,
        allowedRegions: currentConstraints.constraints.allowedRegions,
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
        guardrails: evidence.guardrails,
        killSwitches: evidence.killSwitches,
        credentialRequirementIds: evidence.credentialRequirementIds,
        credentialSnapshot: evidence.credentialSnapshot,
        capacitySnapshot: evidence.capacitySnapshot,
        capacityEvidenceRequired,
        fallbackRequired: step.resourceRequirements.reliability.fallbackRequired,
        fallbackAvailable: evidence.fallbackAvailable,
        idempotencyKey: prior.snapshot.idempotencyKey,
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
        approvalProof,
        stepUpProof,
        now: Date.parse(createdAt)
      });

      if (evaluation.disposition === "BLOCKED") {
        return Object.freeze({
          kind: "blocked" as const,
          reason: `fresh-policy-blocked:${step.id}`
        });
      }
      if (evaluation.disposition !== prior.evaluation.disposition) {
        return Object.freeze({
          kind: "replan-required" as const,
          reason: `policy-disposition-changed:${step.id}:${prior.evaluation.disposition}->${evaluation.disposition}`
        });
      }
      if (!evaluation.readyForTaskGeneration) {
        return Object.freeze({
          kind: prior.evaluation.disposition === "AUTO"
            ? "replan-required" as const
            : "awaiting-approval" as const,
          reason: `fresh-policy-not-authorized:${step.id}`
        });
      }

      if (snapshot.capacitySnapshot) {
        capacityReferences.push({
          id: snapshot.capacitySnapshot.id,
          hash: snapshot.capacitySnapshot.snapshotHash,
          observedAt: snapshot.capacitySnapshot.observedAt,
          expiresAt: snapshot.capacitySnapshot.expiresAt
        });
      }
      if (snapshot.credentialSnapshot) {
        credentialReferences.push({
          id: snapshot.credentialSnapshot.id,
          hash: snapshot.credentialSnapshot.snapshotHash,
          observedAt: snapshot.credentialSnapshot.checkedAt,
          expiresAt: snapshot.credentialSnapshot.expiresAt
        });
      }

      stepEvidence.push(Object.freeze({
        step,
        prior,
        snapshot,
        evaluation,
        approvalProof,
        stepUpProof
      }));
    }

    const validationEvidence = await this.validationEvidence.load({
      run,
      planHash: planArtifact.planHash
    });
    if (validationEvidence.kind === "unavailable") {
      return Object.freeze({
        kind: "defer" as const,
        reason: validationEvidence.reason,
        retryAt: validationEvidence.retryAt
      });
    }

    const nowIso = this.now().toISOString();
    const capacityReference = aggregateReference(
      `validation-capacity:${run.id}`,
      capacityReferences
    );
    const credentialReference = aggregateReference(
      `validation-credentials:${run.id}`,
      credentialReferences
    );
    const validationExpiry = minimumTimestamp([
      validationEvidence.expiresAt,
      validationEvidence.healthReference?.expiresAt,
      capacityReference?.expiresAt,
      credentialReference?.expiresAt,
      new Date(this.now().getTime() + (this.config.validationReceiptTtlMs ?? 5 * 60_000)).toISOString()
    ])!;

    if (validationExpiry <= Date.parse(nowIso)) {
      return Object.freeze({
        kind: "defer" as const,
        reason: "validation-evidence-expired-before-authorization",
        retryAt: new Date(this.now().getTime() + 30_000).toISOString()
      });
    }

    const validationSnapshot = createValidationSnapshot({
      id: `validation-snapshot:authorization:${run.id}:${planArtifact.planHash.slice(0, 16)}`,
      policyVersion: policyBundle.stepPolicies[0]!.snapshot.policyVersion,
      environment: run.environment,
      configurationVersion: validationEvidence.configurationVersion,
      evidenceRequirements: {
        health: validationEvidence.healthReference ? "required" : "not-applicable",
        capacity: capacityReference ? "required" : "not-applicable",
        credentials: credentialReference ? "required" : "not-applicable"
      },
      healthReference: validationEvidence.healthReference,
      capacityReference,
      credentialReference,
      createdAt: nowIso,
      expiresAt: new Date(validationExpiry).toISOString()
    });

    const receipt = createValidationReceipt({
      id: `validation-receipt:authorization:${run.id}:${planArtifact.planHash.slice(0, 16)}`,
      plan: planArtifact.plan,
      attestation: validationArtifact.attestation,
      snapshot: validationSnapshot,
      validatedAt: nowIso,
      expiresAt: new Date(validationExpiry).toISOString()
    });

    const receiptArtifact = createValidationReceiptExecutionArtifact({
      id: executionArtifactId({
        kind: "validation-receipt",
        run,
        predecessorHash: validationArtifact.attestation.attestationHash
      }),
      runId: run.id,
      correlationId: run.correlationId,
      planHash: planArtifact.planHash,
      receipt,
      createdAt: nowIso
    });
    await this.execution.append(run, {
      kind: "validation-receipt",
      value: receiptArtifact
    });

    const issued: AuthorizationGrant[] = [];
    for (const evidence of stepEvidence) {
      const approvalExpiry = evidence.approvalProof?.expiresAt;
      const stepUpExpiry = evidence.stepUpProof?.expiresAt;
      const expiresAt = minimumTimestamp([
        receipt.expiresAt,
        approvalExpiry,
        stepUpExpiry,
        evidence.snapshot.capacitySnapshot?.expiresAt,
        evidence.snapshot.credentialSnapshot?.expiresAt,
        new Date(this.now().getTime() + (this.config.grantTtlMs ?? 5 * 60_000)).toISOString()
      ])!;
      if (expiresAt <= this.now().getTime()) {
        return Object.freeze({
          kind: "replan-required" as const,
          reason: `authorization-evidence-expired:${evidence.step.id}`
        });
      }

      const grant = issueAuthorizationGrant({
        id: `authorization-grant:${sha256Hex({
          runId: run.id,
          planHash: planArtifact.planHash,
          stepHash: evidence.prior.stepHash,
          policySnapshotHash: evidence.snapshot.snapshotHash,
          approvalProofHash: evidence.approvalProof?.proofHash ?? null
        })}`,
        plan: planArtifact.plan,
        stepId: evidence.step.id,
        receipt,
        policySnapshot: evidence.snapshot,
        policyEvaluation: evidence.evaluation,
        actor: evidence.approvalProof
          ? { type: "user", id: evidence.approvalProof.actorId }
          : { type: "system", id: "orchestration-policy" },
        scope: evidence.snapshot.scope,
        approvalProof: evidence.approvalProof,
        stepUpProof: evidence.stepUpProof,
        issuedAt: nowIso,
        expiresAt: new Date(expiresAt).toISOString()
      });

      await this.grants.insert(grant);
      const persisted = await this.grants.get(grant.id);
      if (!persisted || persisted.grantHash !== grant.grantHash) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Authorization grant could not be reconstructed from authoritative storage"
        );
      }
      issued.push(persisted);
    }

    const bundle = createAuthorizationBundleExecutionArtifact({
      id: executionArtifactId({
        kind: "authorization-bundle",
        run,
        predecessorHash: receipt.receiptHash
      }),
      runId: run.id,
      correlationId: run.correlationId,
      planHash: planArtifact.planHash,
      validationReceiptId: receipt.id,
      validationReceiptHash: receipt.receiptHash,
      grants: issued,
      createdAt: nowIso
    });
    await this.execution.append(run, {
      kind: "authorization-bundle",
      value: bundle
    });

    return Object.freeze({
      kind: "authorized" as const,
      grants: Object.freeze(issued)
    });
  }
}
