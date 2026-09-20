import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { DecisionAction } from "@/lib/control-plane/schemas";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { assertStepUpProof, type StepUpProof } from "@/lib/authorization/proofs";
import type { DecisionTransactionManager } from "@/lib/domain/decision-transaction";
import { authoritativeTransitionService } from "@/lib/domain/services/transition-service";

export type AuthoritativeDecisionStatus = "pending" | "approved" | "modified" | "rejected";

export interface AuthoritativeDecision {
  id: string;
  portfolioId: string;
  companyId: string;
  status: AuthoritativeDecisionStatus;
  version: number;
  requiresStepUp: boolean;
  updatedAt: string;
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

  const nextState = targetState(input.action);
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
    beforeTransition: (current) => {
      if (current.requiresStepUp && input.action === "approve") {
        if (!input.stepUpProof) {
          throw new ControlPlaneError("FORBIDDEN", "Fresh step-up proof is required for this approval", {
            correlationId: input.command.correlationId
          });
        }
        assertStepUpProof(input.stepUpProof, {
          actorId: input.command.actor.id,
          scope: input.command.scope
        });
      }
    },
    metadata: () => ({
      stepUpProofId: input.stepUpProof?.id ?? null
    })
  });
}
