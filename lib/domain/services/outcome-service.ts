import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import {
  executeTransitionCommand,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";
import {
  assertVerificationReceipt,
  type VerificationReceipt
} from "@/lib/verification/verification";

export type OutcomeState = "recorded" | "verified" | "uncertain" | "rejected";

export interface OutcomeRecord extends StatefulEntity {
  state: OutcomeState;
  objectiveId?: string;
  taskId?: string;
  jobId?: string;
  metric: string;
  value: number | string | boolean;
  evidenceIds: readonly string[];
  verificationReceiptId?: string;
  verificationReceiptHash?: string;
  confidence?: number;
}

export interface OutcomeStores {
  outcomes: EntityStore<OutcomeRecord>;
}

export class OutcomeService {
  constructor(private readonly transactions: ControlPlaneTransactionManager<OutcomeStores>) {}

  verify(
    id: string,
    command: AuthoritativeCommandEnvelope,
    receipt: VerificationReceipt
  ) {
    assertVerificationReceipt(receipt, {
      scope: command.scope,
      subject: { type: "outcome", id },
      allowedVerdicts: ["verified"]
    });

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.outcomes,
      entityType: "outcome",
      entityId: id,
      to: "verified",
      command,
      triggeringEvent: "outcome-verified",
      patch: () => ({
        evidenceIds: [...receipt.evidenceIds],
        verificationReceiptId: receipt.id,
        verificationReceiptHash: receipt.receiptHash
      }),
      metadata: () => ({
        verificationReceiptId: receipt.id,
        verificationReceiptHash: receipt.receiptHash
      })
    });
  }

  markUncertain(
    id: string,
    command: AuthoritativeCommandEnvelope,
    receipt: VerificationReceipt
  ) {
    assertVerificationReceipt(receipt, {
      scope: command.scope,
      subject: { type: "outcome", id },
      allowedVerdicts: ["uncertain"]
    });

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.outcomes,
      entityType: "outcome",
      entityId: id,
      to: "uncertain",
      command,
      triggeringEvent: "outcome-uncertain",
      patch: () => ({
        evidenceIds: [...receipt.evidenceIds],
        verificationReceiptId: receipt.id,
        verificationReceiptHash: receipt.receiptHash
      })
    });
  }

  reject(
    id: string,
    command: AuthoritativeCommandEnvelope,
    receipt: VerificationReceipt
  ) {
    assertVerificationReceipt(receipt, {
      scope: command.scope,
      subject: { type: "outcome", id },
      allowedVerdicts: ["failed"]
    });

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.outcomes,
      entityType: "outcome",
      entityId: id,
      to: "rejected",
      command,
      triggeringEvent: "outcome-rejected",
      patch: () => ({
        evidenceIds: [...receipt.evidenceIds],
        verificationReceiptId: receipt.id,
        verificationReceiptHash: receipt.receiptHash
      })
    });
  }
}
