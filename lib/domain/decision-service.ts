import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { DecisionAction } from "@/lib/control-plane/schemas";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import {
  assertStepUpProof,
  type ApprovalLevel,
  type ApprovalProof,
  type StepUpProof
} from "@/lib/authorization/proofs";
import { createAuditEvent } from "@/lib/domain/audit";
import {
  createApprovalGrantPatch,
  type ApprovalRecord
} from "@/lib/domain/services/approval-service";
import type { DecisionTransactionManager } from "@/lib/domain/decision-transaction";
import { authoritativeTransitionService } from "@/lib/domain/services/transition-service";

export type AuthoritativeDecisionStatus = "pending" | "approved" | "modified" | "rejected";

export interface AuthoritativeDecision {
  id: string;
  correlationId?: string;
  portfolioId: string;
  companyId: string;
  status: AuthoritativeDecisionStatus;
  version: number;
  requiresStepUp: boolean;
  updatedAt: string;

  /** Optional governed-orchestration binding. Generic Decisions may omit these fields. */
  orchestrationRunId?: string;
  planId?: string;
  planHash?: string;
  stepId?: string;
  stepHash?: string;
  policySnapshotId?: string;
  policySnapshotHash?: string;
  approvalId?: string;
  approvalRequirement?: ApprovalLevel;

  resolvedBy?: string;
  approvalProofId?: string;
  approvalProofHash?: string;

  /** Owner-facing presentation remains evidence about the authority object, not authority itself. */
  title?: string;
  subtitle?: string;
  priority?: "high" | "normal" | "fyi";
  category?: "resource" | "growth" | "incident" | "budget" | "outreach";
  rationale?: string;
  impact?: readonly string[];
}

export interface DecisionAuthorityStore {
  get(id: string): Promise<AuthoritativeDecision | null>;
  save(next: AuthoritativeDecision, expectedVersion: number): Promise<void>;
}

export interface DecisionMutation {
  type: "decision.resolve";
  decisionId: string;
  action: DecisionAction;
}

export interface ResolveDecisionInput {
  command: AuthoritativeCommandEnvelope<DecisionMutation>;
  transactionManager: DecisionTransactionManager;
  decisionId: string;
  action: DecisionAction;
  stepUpProof?: StepUpProof;
  now?: () => Date;
}

function targetState(action: DecisionAction): AuthoritativeDecisionStatus {
  if (action === "approve") return "approved";
  if (action === "modify") return "modified";
  return "rejected";
}

export async function resolveDecision(input: ResolveDecisionInput): Promise<AuthoritativeDecision> {
  if (
    input.command.requestedMutation.type !== "decision.resolve"
    || input.command.requestedMutation.decisionId !== input.decisionId
    || input.command.requestedMutation.action !== input.action
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Decision command mutation does not match requested decision action");
  }

  const now = input.now ?? (() => new Date());
  const nextState = targetState(input.action);
  let pairedApprovalProof: ApprovalProof | undefined;

  return authoritativeTransitionService.transition({
    manager: input.transactionManager,
    selectStore: (stores) => stores.decisions,
    entityType: "decision",
    entityId: input.decisionId,
    to: nextState,
    command: input.command,
    triggeringEvent: `decision-${nextState}`,
    stateOf: (decision) => decision.status,
    applyState: (decision, state) => ({
      ...decision,
      status: state as AuthoritativeDecisionStatus
    }),
    beforeTransition: async (current, transaction) => {
      if (current.requiresStepUp && input.action === "approve") {
        if (!input.stepUpProof) {
          throw new ControlPlaneError("FORBIDDEN", "Fresh step-up proof is required for this approval", {
            correlationId: input.command.correlationId
          });
        }
        assertStepUpProof(input.stepUpProof, {
          actorId: input.command.actor.id,
          scope: input.command.scope,
          now: now().getTime()
        });
      }

      if (!current.approvalId) return;

      if (
        !current.planHash
        || !current.stepHash
        || !current.approvalRequirement
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Orchestration-bound Decision is missing exact approval authority binding",
          { correlationId: input.command.correlationId }
        );
      }

      const approvals = transaction.stores.approvals;
      if (!approvals) {
        throw new ControlPlaneError(
          "UNAVAILABLE",
          "Paired Approval authority store is required for orchestration-bound Decisions"
        );
      }
      const approval = await approvals.get(current.approvalId);
      if (
        !approval
        || approval.decisionId !== current.id
        || approval.requirement !== current.approvalRequirement
        || approval.state !== "pending"
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Paired Approval authority does not match the pending Decision"
        );
      }

      const resolvedAt = now().toISOString();
      let nextApproval: ApprovalRecord;

      if (input.action === "approve") {
        const defaultExpiry = now().getTime() + 5 * 60_000;
        const stepUpExpiry = input.stepUpProof
          ? Date.parse(input.stepUpProof.expiresAt)
          : Number.POSITIVE_INFINITY;
        const proofExpiry = Math.min(defaultExpiry, stepUpExpiry);
        if (!Number.isFinite(proofExpiry) || proofExpiry <= Date.parse(resolvedAt)) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Approval proof cannot outlive or begin after its supporting authentication"
          );
        }

        const patch = createApprovalGrantPatch({
          current: approval,
          command: input.command,
          grant: {
            planHash: current.planHash,
            stepHash: current.stepHash,
            proofExpiresAt: new Date(proofExpiry).toISOString(),
            stepUpProof: input.stepUpProof
          },
          grantedAt: resolvedAt
        });
        pairedApprovalProof = patch.approvalProof;
        nextApproval = {
          ...approval,
          ...patch,
          correlationId: approval.correlationId ?? input.command.correlationId,
          state: "granted",
          version: approval.version + 1,
          updatedAt: resolvedAt
        };
      } else {
        nextApproval = {
          ...approval,
          correlationId: approval.correlationId ?? input.command.correlationId,
          state: "denied",
          deniedBy: input.command.actor.id,
          version: approval.version + 1,
          updatedAt: resolvedAt
        };
      }

      await approvals.save(nextApproval, approval.version);
      await transaction.audit.append(createAuditEvent({
        correlationId: nextApproval.correlationId ?? input.command.correlationId,
        eventType: input.action === "approve" ? "approval.granted" : "approval.denied",
        actor: input.command.actor,
        scope: {
          userId: input.command.scope.userId,
          portfolioId: input.command.scope.portfolioId,
          companyId: input.command.scope.companyId,
          resourceId: input.command.scope.resourceId
        },
        environment: input.command.environment,
        entityType: "approval",
        entityId: nextApproval.id,
        previousState: "pending",
        newState: nextApproval.state,
        provenance: input.command.provenance,
        metadata: {
          commandId: input.command.commandId,
          decisionId: current.id,
          planHash: current.planHash,
          stepHash: current.stepHash,
          approvalProofId: pairedApprovalProof?.id ?? null,
          approvalProofHash: pairedApprovalProof?.proofHash ?? null
        }
      }));
    },
    patch: (current) => ({
      resolvedBy: input.command.actor.id,
      approvalProofId: pairedApprovalProof?.id ?? current.approvalProofId,
      approvalProofHash: pairedApprovalProof?.proofHash ?? current.approvalProofHash
    }),
    metadata: (current) => ({
      stepUpProofId: input.stepUpProof?.id ?? null,
      orchestrationRunId: current.orchestrationRunId ?? null,
      planHash: current.planHash ?? null,
      stepHash: current.stepHash ?? null,
      approvalId: current.approvalId ?? null,
      approvalProofId: pairedApprovalProof?.id ?? null,
      approvalProofHash: pairedApprovalProof?.proofHash ?? null
    }),
    now
  });
}
