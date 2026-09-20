import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import {
  executeTransitionCommand,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";
import {
  resolveVerificationRequest,
  type VerificationEvidence,
  type VerificationReceipt,
  type VerificationRequest,
  type VerificationVerdict
} from "@/lib/verification/verification";

export type VerificationState =
  | "requested"
  | "collecting"
  | VerificationVerdict
  | "cancelled";

export interface VerificationRequestRecord extends StatefulEntity {
  state: VerificationState;
  request: VerificationRequest;
  receipt?: VerificationReceipt;
}

export interface VerificationStores {
  verifications: EntityStore<VerificationRequestRecord>;
}

export class VerificationService {
  constructor(
    private readonly transactions: ControlPlaneTransactionManager<VerificationStores>
  ) {}

  beginCollecting(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.verifications,
      entityType: "verification",
      entityId: id,
      to: "collecting",
      command,
      triggeringEvent: "verification-collecting"
    });
  }

  resolve(
    id: string,
    command: AuthoritativeCommandEnvelope,
    evidence: readonly VerificationEvidence[],
    input: {
      receiptId: string;
      verifiedAt?: string;
      receiptTtlSeconds?: number;
    }
  ) {
    let receipt: VerificationReceipt | undefined;

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.verifications,
      entityType: "verification",
      entityId: id,
      to: "uncertain",
      command,
      triggeringEvent: "verification-resolved",
      beforeTransition: (current) => {
        receipt = resolveVerificationRequest(current.request, evidence, input);
      },
      patch: () => ({ receipt }),
      metadata: () => ({
        receiptId: input.receiptId,
        evidenceCount: evidence.length
      })
    }).then(async (intermediate) => {
      if (!receipt || receipt.verdict === "uncertain") return intermediate;

      return executeTransitionCommand({
        manager: this.transactions,
        selectStore: (stores) => stores.verifications,
        entityType: "verification",
        entityId: id,
        to: receipt.verdict,
        command: {
          ...command,
          commandId: command.commandId + ":" + receipt.verdict,
          idempotencyKey: command.idempotencyKey + ":" + receipt.verdict
        },
        triggeringEvent: "verification-" + receipt.verdict,
        patch: () => ({ receipt })
      });
    });
  }

  cancel(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.verifications,
      entityType: "verification",
      entityId: id,
      to: "cancelled",
      command,
      triggeringEvent: "verification-cancelled"
    });
  }
}
