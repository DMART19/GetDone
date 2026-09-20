import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import {
  executeTransitionCommand,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";
import {
  requireAuthoritativeVerificationReceipt,
  type VerificationReceipt,
  type VerificationReceiptStore
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
  verificationReceipts?: VerificationReceiptStore;
}

export class OutcomeService {
  constructor(private readonly transactions: ControlPlaneTransactionManager<OutcomeStores>) {}

  verify(
    id: string,
    command: AuthoritativeCommandEnvelope,
    receiptId: string
  ) {
    return this.resolveWithReceipt(id, command, receiptId, "verified", "verified");
  }

  markUncertain(
    id: string,
    command: AuthoritativeCommandEnvelope,
    receiptId: string
  ) {
    return this.resolveWithReceipt(id, command, receiptId, "uncertain", "uncertain");
  }

  reject(
    id: string,
    command: AuthoritativeCommandEnvelope,
    receiptId: string
  ) {
    return this.resolveWithReceipt(id, command, receiptId, "rejected", "failed");
  }

  private resolveWithReceipt(
    id: string,
    command: AuthoritativeCommandEnvelope,
    receiptId: string,
    to: OutcomeState,
    allowedVerdict: "verified" | "uncertain" | "failed"
  ) {
    let receipt: VerificationReceipt | undefined;

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.outcomes,
      entityType: "outcome",
      entityId: id,
      to,
      command,
      triggeringEvent: "outcome-" + to,
      beforeTransition: async (_current, transaction) => {
        const store = transaction.stores.verificationReceipts;
        if (!store) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Authoritative verification receipt storage is required for Outcome truth"
          );
        }
        receipt = await requireAuthoritativeVerificationReceipt(store, receiptId, {
          scope: command.scope,
          subject: { type: "outcome", id },
          allowedVerdicts: [allowedVerdict]
        });
      },
      patch: () => {
        if (!receipt) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Authoritative Outcome verification receipt is unavailable"
          );
        }
        return {
          evidenceIds: [...receipt.evidenceIds],
          verificationReceiptId: receipt.id,
          verificationReceiptHash: receipt.receiptHash
        };
      },
      metadata: () => ({ verificationReceiptId: receiptId })
    });
  }
}
