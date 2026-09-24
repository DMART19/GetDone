import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { commandFingerprint } from "@/lib/control-plane/command-envelope";
import { createAuditEvent } from "@/lib/domain/audit";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import { claimIdempotency } from "@/lib/domain/idempotency";
import {
  executeTransitionCommand,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";
import {
  assertVerificationRequestIntegrity,
  resolveVerificationRequest,
  type VerificationEvidence,
  type VerificationReceipt,
  type VerificationReceiptStore,
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

export interface VerificationStore
  extends EntityStore<VerificationRequestRecord>, VerificationReceiptStore {
  create(record: VerificationRequestRecord): Promise<void>;
}

export interface VerificationStores {
  verifications: VerificationStore;
}

export class VerificationService {
  constructor(
    private readonly transactions: ControlPlaneTransactionManager<VerificationStores>
  ) {}

  async request(
    request: VerificationRequest,
    command: AuthoritativeCommandEnvelope
  ) {
    assertVerificationRequestIntegrity(request);

    if (
      request.portfolioId !== command.scope.portfolioId
      || request.companyId !== command.scope.companyId
      || request.environment !== command.scope.environment
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Verification request does not match authoritative command scope"
      );
    }

    const fingerprint = commandFingerprint(command);

    return this.transactions.run(async (transaction) => {
      const claim = await claimIdempotency<VerificationRequestRecord>(
        transaction.idempotency,
        command.idempotencyKey,
        fingerprint,
        new Date(request.requestedAt)
      );

      if (claim.state === "COMPLETED" && claim.record.result) {
        return claim.record.result;
      }
      if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
        throw new ControlPlaneError(
          "CONFLICT",
          "Verification request command is already in progress or previously failed"
        );
      }

      const record: VerificationRequestRecord = Object.freeze({
        id: request.id,
        correlationId: request.correlationId ?? command.correlationId,
        portfolioId: request.portfolioId,
        companyId: request.companyId,
        state: "requested",
        request,
        version: 1,
        updatedAt: request.requestedAt
      });

      await transaction.stores.verifications.create(record);
      await transaction.audit.append(createAuditEvent({
        correlationId: command.correlationId,
        eventType: "verification.requested",
        actor: command.actor,
        scope: {
          userId: command.scope.userId,
          portfolioId: command.scope.portfolioId,
          companyId: command.scope.companyId,
          resourceId: command.scope.resourceId
        },
        environment: command.environment,
        entityType: "verification",
        entityId: request.id,
        newState: "requested",
        provenance: command.provenance,
        metadata: {
          commandId: command.commandId,
          subjectType: request.subject.type,
          subjectId: request.subject.id,
          requestHash: request.requestHash
        }
      }));
      await transaction.idempotency.complete(
        command.idempotencyKey,
        fingerprint,
        record,
        request.requestedAt
      );

      return record;
    });
  }

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
