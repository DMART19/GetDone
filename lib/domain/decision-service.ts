import { createAuditEvent } from "@/lib/domain/audit";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { RequestContext } from "@/lib/control-plane/request-context";
import type { DecisionAction } from "@/lib/control-plane/schemas";
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

export interface ResolveDecisionInput {
  context: RequestContext;
  transactionManager: DecisionTransactionManager;
  idempotencyKey: string;
  decisionId: string;
  action: DecisionAction;
  stepUpSatisfied: boolean;
}

function targetState(action: DecisionAction): AuthoritativeDecisionStatus {
  if (action === "approve") return "approved";
  if (action === "modify") return "modified";
  return "rejected";
}

function decisionFingerprint(input: ResolveDecisionInput) {
  return [
    input.context.actor.id,
    input.context.scope.portfolioId ?? "-",
    input.context.scope.companyId ?? "-",
    input.decisionId,
    input.action
  ].join(":");
}

export async function resolveDecision(input: ResolveDecisionInput): Promise<AuthoritativeDecision> {
  return input.transactionManager.run(async (transaction) => {
    const claim = await claimIdempotency(
      transaction.idempotency,
      input.idempotencyKey,
      decisionFingerprint(input)
    );

    if (!claim.isNew) {
      if (claim.record.status === "completed" && claim.record.result) {
        return claim.record.result as AuthoritativeDecision;
      }
      throw new ControlPlaneError("CONFLICT", "The same decision request is already in progress or previously failed", {
        correlationId: input.context.correlationId
      });
    }

    const current = await transaction.decisions.get(input.decisionId);
    if (!current) {
      throw new ControlPlaneError("NOT_FOUND", "Decision was not found", {
        correlationId: input.context.correlationId
      });
    }

    if (
      current.portfolioId !== input.context.scope.portfolioId
      || current.companyId !== input.context.scope.companyId
    ) {
      throw new ControlPlaneError("FORBIDDEN", "Decision is outside the trusted request scope", {
        correlationId: input.context.correlationId
      });
    }

    if (current.requiresStepUp && input.action === "approve" && !input.stepUpSatisfied) {
      throw new ControlPlaneError("FORBIDDEN", "Fresh step-up authentication is required for this approval", {
        correlationId: input.context.correlationId
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

    await transaction.decisions.save(next, current.version);
    await transaction.audit.append(createAuditEvent({
      correlationId: input.context.correlationId,
      eventType: `decision.${nextState}`,
      actor: input.context.actor,
      scope: input.context.scope,
      environment: input.context.environment,
      entityType: "decision",
      entityId: current.id,
      previousState: current.status,
      newState: next.status,
      provenance: "getdone-control-plane",
      metadata: { idempotencyKey: input.idempotencyKey }
    }));

    await transaction.idempotency.put({
      ...claim.record,
      status: "completed",
      completedAt: new Date().toISOString(),
      result: next
    });

    return next;
  });
}
