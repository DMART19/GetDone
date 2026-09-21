import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import {
  assertApprovalProof,
  assertStepUpProof,
  createApprovalProof,
  type ApprovalProof,
  type StepUpProof
} from "@/lib/authorization/proofs";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import {
  executeTransitionCommand,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";

export type ApprovalState = "pending" | "granted" | "denied" | "expired";

export interface ApprovalRecord extends StatefulEntity {
  state: ApprovalState;
  decisionId: string;
  requirement: "approval" | "strong-approval";
  grantedBy?: string;
  deniedBy?: string;
  approvalProof?: ApprovalProof;
}

export interface ApprovalStores {
  approvals: EntityStore<ApprovalRecord>;
}

export interface GrantApprovalInput {
  planHash: string;
  stepHash: string;
  proofExpiresAt: string;
  stepUpProof?: StepUpProof;
}

export class ApprovalService {
  constructor(
    private readonly transactions: ControlPlaneTransactionManager<ApprovalStores>,
    private readonly now: () => Date = () => new Date()
  ) {}

  grant(
    id: string,
    command: AuthoritativeCommandEnvelope,
    input: GrantApprovalInput
  ) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.approvals,
      entityType: "approval",
      entityId: id,
      to: "granted",
      command,
      triggeringEvent: "approval-granted",
      patch: (current) => {
        if (!input.planHash || !input.stepHash) {
          throw new ControlPlaneError(
            "VALIDATION_FAILED",
            "Approval proof must bind to an exact plan and step"
          );
        }

        if (current.requirement === "strong-approval") {
          if (!input.stepUpProof) {
            throw new ControlPlaneError(
              "FORBIDDEN",
              "Fresh step-up proof is required for strong approval"
            );
          }
          assertStepUpProof(input.stepUpProof, {
            actorId: command.actor.id,
            scope: command.scope,
            now: this.now().getTime()
          });
        }

        const grantedAt = this.now().toISOString();
        const proof = createApprovalProof({
          id: `approval-proof:${current.id}:${current.version + 1}`,
          decisionId: current.decisionId,
          approvalId: current.id,
          actorId: command.actor.id,
          scope: command.scope,
          level: current.requirement,
          planHash: input.planHash,
          stepHash: input.stepHash,
          grantedAt,
          expiresAt: input.proofExpiresAt,
          stepUpProofId: input.stepUpProof?.id
        });

        assertApprovalProof(proof, {
          actorId: command.actor.id,
          scope: command.scope,
          planHash: input.planHash,
          stepHash: input.stepHash,
          requiredLevel: current.requirement,
          stepUpProof: input.stepUpProof,
          now: this.now().getTime()
        });

        return {
          grantedBy: command.actor.id,
          approvalProof: proof
        };
      },
      metadata: (current) => ({
        requirement: current.requirement,
        stepUpProofId: input.stepUpProof?.id ?? null,
        planHash: input.planHash,
        stepHash: input.stepHash
      }),
      now: this.now
    });
  }

  deny(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.approvals,
      entityType: "approval",
      entityId: id,
      to: "denied",
      command,
      triggeringEvent: "approval-denied",
      patch: () => ({ deniedBy: command.actor.id }),
      now: this.now
    });
  }

  expire(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.approvals,
      entityType: "approval",
      entityId: id,
      to: "expired",
      command,
      triggeringEvent: "approval-expired",
      now: this.now
    });
  }
}
