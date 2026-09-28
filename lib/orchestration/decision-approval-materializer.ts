import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { createAuditEvent } from "@/lib/domain/audit";
import type { AuthoritativeDecision } from "@/lib/domain/decision-service";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import type { EntityStore } from "@/lib/domain/services/common";
import type { ApprovalRecord } from "@/lib/domain/services/approval-service";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import {
  assertGovernedPlanArtifactIntegrity,
  assertPolicyBundleArtifactIntegrity,
  type GovernedPlanArtifact,
  type PolicyBundleArtifact
} from "@/lib/orchestration/planning-artifacts";

export interface CreatableEntityStore<T> extends EntityStore<T> {
  create(entity: T): Promise<void>;
}

export interface DecisionApprovalMaterializerStores {
  decisions: CreatableEntityStore<AuthoritativeDecision>;
  approvals: CreatableEntityStore<ApprovalRecord>;
}

export interface DecisionApprovalBinding {
  stepId: string;
  stepHash: string;
  decisionId: string;
  approvalId: string;
  requirement: "approval" | "strong-approval";
}

function bindingId(run: OrchestrationRun, stepHash: string) {
  return sha256Hex({
    runId: run.id,
    correlationId: run.correlationId,
    stepHash
  });
}

function assertSameDecision(
  current: AuthoritativeDecision,
  expected: AuthoritativeDecision
) {
  const fields: Array<keyof AuthoritativeDecision> = [
    "orchestrationRunId",
    "planId",
    "planHash",
    "stepId",
    "stepHash",
    "policySnapshotId",
    "policySnapshotHash",
    "approvalId",
    "approvalRequirement"
  ];
  for (const field of fields) {
    if (current[field] !== expected[field]) {
      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        `Existing Decision differs from governed orchestration binding: ${String(field)}`
      );
    }
  }
}

function assertSameApproval(current: ApprovalRecord, expected: ApprovalRecord) {
  if (
    current.decisionId !== expected.decisionId
    || current.requirement !== expected.requirement
    || current.portfolioId !== expected.portfolioId
    || current.companyId !== expected.companyId
  ) {
    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Existing Approval differs from governed orchestration binding"
    );
  }
}

export class DecisionApprovalMaterializer {
  constructor(
    private readonly transactions:
      ControlPlaneTransactionManager<DecisionApprovalMaterializerStores>,
    private readonly now: () => Date = () => new Date()
  ) {}

  async ensure(input: {
    run: OrchestrationRun;
    plan: GovernedPlanArtifact;
    policy: PolicyBundleArtifact;
  }): Promise<readonly DecisionApprovalBinding[]> {
    const { run, plan, policy } = input;
    assertGovernedPlanArtifactIntegrity(plan);
    assertPolicyBundleArtifactIntegrity(policy);

    if (
      plan.runId !== run.id
      || policy.runId !== run.id
      || policy.planHash !== plan.planHash
      || policy.planArtifactId !== plan.id
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Decision materialization requires exact orchestration plan/policy lineage"
      );
    }

    const required = policy.stepPolicies.filter((step) =>
      step.evaluation.disposition === "APPROVAL_REQUIRED"
      || step.evaluation.disposition === "STRONG_APPROVAL"
    );

    return this.transactions.run(async (transaction) => {
      const bindings: DecisionApprovalBinding[] = [];
      const timestamp = this.now().toISOString();

      for (const stepPolicy of required) {
        const planStep = plan.plan.steps.find((step) => step.id === stepPolicy.stepId);
        if (!planStep) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            `Policy step is absent from governed plan: ${stepPolicy.stepId}`
          );
        }

        const suffix = bindingId(run, stepPolicy.stepHash);
        const decisionId = `decision:orchestration:${suffix}`;
        const approvalId = `approval:orchestration:${suffix}`;
        const requirement = stepPolicy.evaluation.disposition === "STRONG_APPROVAL"
          ? "strong-approval" as const
          : "approval" as const;

        const decision: AuthoritativeDecision = Object.freeze({
          id: decisionId,
          correlationId: run.correlationId,
          portfolioId: run.portfolioId,
          companyId: run.companyId,
          status: "pending",
          version: 1,
          requiresStepUp:
            requirement === "strong-approval"
            || stepPolicy.evaluation.requiresFreshStepUp,
          orchestrationRunId: run.id,
          planId: plan.plan.id,
          planHash: plan.planHash,
          stepId: planStep.id,
          stepHash: stepPolicy.stepHash,
          policySnapshotId: stepPolicy.snapshot.id,
          policySnapshotHash: stepPolicy.snapshot.snapshotHash,
          approvalId,
          approvalRequirement: requirement,
          updatedAt: timestamp
        });

        const approval: ApprovalRecord = Object.freeze({
          id: approvalId,
          correlationId: run.correlationId,
          portfolioId: run.portfolioId,
          companyId: run.companyId,
          state: "pending",
          decisionId,
          requirement,
          version: 1,
          updatedAt: timestamp
        });

        const existingDecision = await transaction.stores.decisions.get(decisionId);
        const existingApproval = await transaction.stores.approvals.get(approvalId);

        if (existingDecision || existingApproval) {
          if (!existingDecision || !existingApproval) {
            throw new ControlPlaneError(
              "CONFLICT",
              "Decision/Approval materialization is partially persisted"
            );
          }
          assertSameDecision(existingDecision, decision);
          assertSameApproval(existingApproval, approval);
          bindings.push(Object.freeze({
            stepId: planStep.id,
            stepHash: stepPolicy.stepHash,
            decisionId,
            approvalId,
            requirement
          }));
          continue;
        }

        await transaction.stores.decisions.create(decision);
        await transaction.stores.approvals.create(approval);

        await transaction.audit.append(createAuditEvent({
          correlationId: run.correlationId,
          eventType: "decision.pending",
          actor: { type: "system", id: "orchestration" },
          scope: {
            userId: run.authorityUserId,
            portfolioId: run.portfolioId,
            companyId: run.companyId
          },
          environment: run.environment,
          entityType: "decision",
          entityId: decision.id,
          newState: "pending",
          provenance: "orchestration:decision-materializer",
          metadata: {
            orchestrationRunId: run.id,
            planId: plan.plan.id,
            planHash: plan.planHash,
            stepId: planStep.id,
            stepHash: stepPolicy.stepHash,
            approvalId,
            approvalRequirement: requirement
          }
        }));

        await transaction.audit.append(createAuditEvent({
          correlationId: run.correlationId,
          eventType: "approval.pending",
          actor: { type: "system", id: "orchestration" },
          scope: {
            userId: run.authorityUserId,
            portfolioId: run.portfolioId,
            companyId: run.companyId
          },
          environment: run.environment,
          entityType: "approval",
          entityId: approval.id,
          newState: "pending",
          provenance: "orchestration:decision-materializer",
          metadata: {
            decisionId,
            planHash: plan.planHash,
            stepHash: stepPolicy.stepHash,
            requirement
          }
        }));

        bindings.push(Object.freeze({
          stepId: planStep.id,
          stepHash: stepPolicy.stepHash,
          decisionId,
          approvalId,
          requirement
        }));
      }

      return Object.freeze(bindings);
    });
  }
}
