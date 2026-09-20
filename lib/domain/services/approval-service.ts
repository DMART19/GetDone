import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { assertStepUpProof, type StepUpProof } from "@/lib/authorization/proofs";
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
}

export interface ApprovalStores {
  approvals: EntityStore<ApprovalRecord>;
}

export class ApprovalService {
  constructor(private readonly transactions: ControlPlaneTransactionManager<ApprovalStores>) {}

  grant(id: string, command: AuthoritativeCommandEnvelope, stepUpProof?: StepUpProof) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.approvals,
      entityType: "approval",
      entityId: id,
      to: "granted",
      command,
      triggeringEvent: "approval-granted",
      patch: (current) => {
        if (current.requirement === "strong-approval") {
          if (!stepUpProof) {
            throw new ControlPlaneError("FORBIDDEN", "Fresh step-up proof is required for strong approval");
          }
          assertStepUpProof(stepUpProof, {
            actorId: command.actor.id,
            scope: command.scope
          });
        }
        return { grantedBy: command.actor.id };
      },
      metadata: (current) => ({
        requirement: current.requirement,
        stepUpProofId: stepUpProof?.id ?? null
      })
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
      patch: () => ({ deniedBy: command.actor.id })
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
      triggeringEvent: "approval-expired"
    });
  }
}
