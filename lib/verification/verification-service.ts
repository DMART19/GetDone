import { createAuditEvent } from "@/lib/domain/audit";
import { commandFingerprint, type AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { claimIdempotency } from "@/lib/domain/idempotency";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import {
  executeTransitionCommand,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";
import {
  assertVerificationEvidence,
  assertVerificationReceipt,
  createVerificationRequest,
  type VerificationEvidence,
  type VerificationReceipt,
  type VerificationRequest,
  type VerificationResult,
  type VerificationStrategy,
  type VerificationTargetType
} from "@/lib/verification/verification";

export type VerificationState =
  | "requested"
  | "collecting"
  | "evaluating"
  | "verified"
  | "failed"
  | "uncertain"
  | "cancelled";

export interface VerificationRecord extends StatefulEntity {
  state: VerificationState;
  request: VerificationRequest;
  evidence: readonly VerificationEvidence[];
  receipt?: VerificationReceipt;
}

export interface VerificationStore extends EntityStore<VerificationRecord> {
  create(record: VerificationRecord): Promise<void>;
}

export interface VerificationStores {
  verifications: VerificationStore;
}

export interface RequestVerificationInput {
  id: string;
  targetType: VerificationTargetType;
  targetId: string;
  strategies: readonly VerificationStrategy[];
  minEvidenceCount?: number;
  requireIndependentEvidence?: boolean;
  maxEvidenceAgeSeconds?: number;
  requestedAt?: string;
  expiresAt: string;
}

export class VerificationService {
  constructor(private readonly transactions: ControlPlaneTransactionManager<VerificationStores>) {}

  request(input: RequestVerificationInput, command: AuthoritativeCommandEnvelope) {
    const requestedAt = input.requestedAt ?? new Date().toISOString();
    const request = createVerificationRequest({
      id: input.id,
      scope: command.scope,
      targetType: input.targetType,
      targetId: input.targetId,
      strategies: input.strategies,
      minEvidenceCount: input.minEvidenceCount ?? 1,
      requireIndependentEvidence: input.requireIndependentEvidence ?? true,
      maxEvidenceAgeSeconds: input.maxEvidenceAgeSeconds ?? 300,
      requestedAt,
      expiresAt: input.expiresAt
    });
    const fingerprint = commandFingerprint(command);

    return this.transactions.run(async (transaction) => {
      const claim = await claimIdempotency<VerificationRecord>(
        transaction.idempotency,
        command.idempotencyKey,
        fingerprint,
        new Date(requestedAt)
      );

      if (claim.state === "COMPLETED" && claim.record.result) return claim.record.result;
      if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
        throw new ControlPlaneError("CONFLICT", "Verification request command is not retryable yet");
      }

      const record: VerificationRecord = Object.freeze({
        id: input.id,
        portfolioId: command.scope.portfolioId,
        companyId: command.scope.companyId,
        state: "requested",
        request,
        evidence: Object.freeze([]),
        version: 1,
        updatedAt: requestedAt
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
        entityId: record.id,
        newState: "requested",
        provenance: command.provenance,
        metadata: {
          targetType: request.targetType,
          targetId: request.targetId,
          requestHash: request.requestHash
        }
      }));

      await transaction.idempotency.complete(
        command.idempotencyKey,
        fingerprint,
        record,
        requestedAt
      );
      return record;
    });
  }

  beginCollection(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.verifications,
      entityType: "verification",
      entityId: id,
      to: "collecting",
      command,
      triggeringEvent: "verification-collection-started"
    });
  }

  evaluate(
    id: string,
    command: AuthoritativeCommandEnvelope,
    evidence: readonly VerificationEvidence[],
    evaluatedAt = Date.now()
  ) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.verifications,
      entityType: "verification",
      entityId: id,
      to: "evaluating",
      command,
      triggeringEvent: "verification-evaluation-started",
      beforeTransition: (current) => {
        for (const item of evidence) {
          assertVerificationEvidence(item, current.request, evaluatedAt);
        }
      },
      patch: () => ({ evidence: Object.freeze([...evidence]) }),
      metadata: () => ({ evidenceCount: evidence.length })
    });
  }

  resolve(
    id: string,
    command: AuthoritativeCommandEnvelope,
    receipt: VerificationReceipt,
    now = Date.now()
  ) {
    const to: VerificationResult = receipt.result;

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.verifications,
      entityType: "verification",
      entityId: id,
      to,
      command,
      triggeringEvent: `verification-${to}`,
      beforeTransition: (current) => {
        assertVerificationReceipt(receipt, {
          scope: command.scope,
          targetType: current.request.targetType,
          targetId: current.request.targetId,
          expectedResult: to,
          now
        });

        if (
          receipt.requestId !== current.request.id
          || receipt.requestHash !== current.request.requestHash
        ) {
          throw new ControlPlaneError("FORBIDDEN", "Verification receipt belongs to another request");
        }

        const currentHashes = current.evidence.map((item) => item.evidenceHash).sort();
        const receiptHashes = [...receipt.evidenceHashes].sort();
        if (
          currentHashes.length !== receiptHashes.length
          || currentHashes.some((item, index) => item !== receiptHashes[index])
        ) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Verification receipt does not bind the authoritative evidence set"
          );
        }
      },
      patch: () => ({ receipt }),
      metadata: () => ({
        receiptId: receipt.id,
        receiptHash: receipt.receiptHash,
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
