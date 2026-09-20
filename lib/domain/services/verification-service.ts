import { ControlPlaneError } from "@/lib/control-plane/errors";
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
    request: VerificationRequest,
    evidence: readonly VerificationEvidence[],
    input: {
      receiptId: string;
      verifiedAt?: string;
      receiptTtlSeconds?: number;
    }
  ) {
    const receipt = resolveVerificationRequest(request, evidence, input);

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.verifications,
      entityType: "verification",
      entityId: id,
      to: receipt.verdict,
      command,
      triggeringEvent: "verification-" + receipt.verdict,
      beforeTransition: (current) => {
        if (
          current.request.id !== request.id
          || current.request.requestHash !== request.requestHash
        ) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Verification request differs from authoritative storage"
          );
        }
      },
      patch: () => ({ receipt }),
      metadata: () => ({
        receiptId: receipt.id,
        receiptHash: receipt.receiptHash,
        verdict: receipt.verdict,
        evidenceCount: receipt.evidenceIds.length
      })
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
