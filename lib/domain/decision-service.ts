import { createAuditEvent } from "@/lib/domain/audit";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { DecisionAction } from "@/lib/control-plane/schemas";
import {
  commandFingerprint,
  type AuthoritativeCommandEnvelope
} from "@/lib/control-plane/command-envelope";
import { assertStepUpProof, type StepUpProof } from "@/lib/authorization/proofs";
import type { DecisionTransactionManager } from "@/lib/domain/decision-transaction";
import { claimIdempotency } from "@/lib/domain/idempotency";
import { assertTransition } from "@/lib/domain/state-machine";

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

  return input.transactionManager.run(async (transaction) => {
    const fingerprint = commandFingerprint(input.command);
    const claim = await claimIdempotency<AuthoritativeDecision>(
      transaction.idempotency,
      input.command.idempotencyKey,
      fingerprint
    );

    if (claim.state === "COMPLETED" && claim.record.result) return claim.record.result;
    if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
      throw new ControlPlaneError("CONFLICT", "The same decision request is already in progress or previously failed", {
        correlationId: input.command.correlationId
      });
    }

    const current = await transaction.stores.decisions.get(input.decisionId);
    if (!current) {
      throw new ControlPlaneError("NOT_FOUND", "Decision was not found", {
        correlationId: input.command.correlationId
      });
    }

    if (
      current.portfolioId !== input.command.scope.portfolioId
      || current.companyId !== input.command.scope.companyId
    ) {
      throw new ControlPlaneError("FORBIDDEN", "Decision is outside the trusted command scope", {
        correlationId: input.command.correlationId
      });
    }

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

    const nextState = targetState(input.action);
    assertTransition("decision", current.status, nextState);

    const next: AuthoritativeDecision = {
      ...current,
      status: nextState,
      version: current.version + 1,
      updatedAt: new Date().toISOString()
    };

    await transaction.stores.decisions.save(next, current.version);
    await transaction.audit.append(createAuditEvent({
      correlationId: input.command.correlationId,
      eventType: `decision.${nextState}`,
      actor: input.command.actor,
      scope: {
        userId: input.command.scope.userId,
        portfolioId: input.command.scope.portfolioId,
        companyId: input.command.scope.companyId,
        resourceId: input.command.scope.resourceId
      },
      environment: input.command.environment,
      entityType: "decision",
      entityId: current.id,
      previousState: current.status,
      newState: next.status,
      provenance: input.command.provenance,
      metadata: {
        commandId: input.command.commandId,
        idempotencyKey: input.command.idempotencyKey,
        stepUpProofId: input.stepUpProof?.id ?? null
      }
    }));

    await transaction.idempotency.complete(
      input.command.idempotencyKey,
      fingerprint,
      next,
      new Date().toISOString()
    );

    return next;
  });
}
