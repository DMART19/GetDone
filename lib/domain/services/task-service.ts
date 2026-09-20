import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  assertAuthorizationGrantEnvelope,
  createAuthorizationConsumptionRecord,
  type AuthorizationConsumptionRecord,
  type AuthorizationGrant,
  type AuthorizationGrantStore
} from "@/lib/authorization/grants";
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

export type TaskState =
  | "proposed"
  | "authorized"
  | "queued"
  | "running"
  | "verifying"
  | "succeeded"
  | "failed"
  | "uncertain"
  | "cancelled";

export interface TaskRecord extends StatefulEntity {
  state: TaskState;
  reason: string;
  evidenceIds: readonly string[];
  capabilityRequirements: readonly string[];
  authorizationLineage: readonly string[];
  authorizationGrantId?: string;
  authorizationGrantHash?: string;
  authorizationConsumption?: AuthorizationConsumptionRecord;
  verificationEvidenceIds: readonly string[];
  verificationReceiptId?: string;
  verificationReceiptHash?: string;
  failureReason?: string;
}

export interface TaskStores {
  tasks: EntityStore<TaskRecord>;
  authorizationGrants?: AuthorizationGrantStore;
  verificationReceipts?: VerificationReceiptStore;
}

export class TaskService {
  constructor(private readonly transactions: ControlPlaneTransactionManager<TaskStores>) {}

  authorize(
    id: string,
    command: AuthoritativeCommandEnvelope,
    grant: AuthorizationGrant,
    consumedAt = new Date().toISOString()
  ) {
    assertAuthorizationGrantEnvelope(grant, command.scope, Date.parse(consumedAt));

    const consumption = createAuthorizationConsumptionRecord({
      id: `authorization-consumption:${grant.id}`,
      grant,
      consumerType: "task",
      consumerId: id,
      consumedAt
    });

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "authorized",
      command,
      triggeringEvent: "task-authorized",
      patch: async (current, transaction) => {
        const required = [...new Set(current.capabilityRequirements)].sort();
        const granted = [...new Set(grant.capabilityNames)].sort();

        if (
          required.length !== granted.length
          || required.some((item, index) => item !== granted[index])
        ) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Authorization grant capabilities do not match the task requirements"
          );
        }

        const grantStore = transaction.stores.authorizationGrants;
        if (!grantStore) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Authorization grant store is required before a task can be authorized"
          );
        }

        const persistedGrant = await grantStore.get(grant.id);
        if (!persistedGrant || persistedGrant.grantHash !== grant.grantHash) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Authorization grant is missing or differs from authoritative storage"
          );
        }
        assertAuthorizationGrantEnvelope(
          persistedGrant,
          command.scope,
          Date.parse(consumedAt)
        );

        await grantStore.consume(consumption);

        return {
          authorizationLineage: [...current.authorizationLineage, grant.id],
          authorizationGrantId: grant.id,
          authorizationGrantHash: grant.grantHash,
          authorizationConsumption: consumption
        };
      },
      metadata: () => ({
        authorizationGrantId: grant.id,
        authorizationGrantHash: grant.grantHash,
        authorizationConsumptionHash: consumption.consumptionHash
      })
    });
  }

  queue(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "queued",
      command,
      triggeringEvent: "task-queued",
      patch: (current) => {
        if (!current.authorizationConsumption) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Task cannot be queued without persisted authorization consumption"
          );
        }
        return {};
      }
    });
  }

  start(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "running",
      command,
      triggeringEvent: "task-started"
    });
  }

  beginVerification(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "verifying",
      command,
      triggeringEvent: "task-verification-started"
    });
  }

  succeed(
    id: string,
    command: AuthoritativeCommandEnvelope,
    receiptId: string
  ) {
    let receipt: VerificationReceipt | undefined;

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "succeeded",
      command,
      triggeringEvent: "task-verified-succeeded",
      beforeTransition: async (_current, transaction) => {
        const store = transaction.stores.verificationReceipts;
        if (!store) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Authoritative verification receipt storage is required for Task success"
          );
        }
        receipt = await requireAuthoritativeVerificationReceipt(store, receiptId, {
          scope: command.scope,
          subject: { type: "task", id },
          allowedVerdicts: ["verified"]
        });
      },
      patch: () => {
        if (!receipt) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Authoritative Task verification receipt is unavailable"
          );
        }
        return {
          verificationEvidenceIds: [...receipt.evidenceIds],
          verificationReceiptId: receipt.id,
          verificationReceiptHash: receipt.receiptHash
        };
      },
      metadata: () => ({ verificationReceiptId: receiptId })
    });
  }

  markUncertain(
    id: string,
    command: AuthoritativeCommandEnvelope,
    receiptId: string
  ) {
    let receipt: VerificationReceipt | undefined;

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "uncertain",
      command,
      triggeringEvent: "task-verification-uncertain",
      beforeTransition: async (_current, transaction) => {
        const store = transaction.stores.verificationReceipts;
        if (!store) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Authoritative verification receipt storage is required for uncertain Task truth"
          );
        }
        receipt = await requireAuthoritativeVerificationReceipt(store, receiptId, {
          scope: command.scope,
          subject: { type: "task", id },
          allowedVerdicts: ["uncertain"]
        });
      },
      patch: () => {
        if (!receipt) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Authoritative Task verification receipt is unavailable"
          );
        }
        return {
          verificationEvidenceIds: [...receipt.evidenceIds],
          verificationReceiptId: receipt.id,
          verificationReceiptHash: receipt.receiptHash
        };
      },
      metadata: () => ({ verificationReceiptId: receiptId })
    });
  }

  fail(
    id: string,
    command: AuthoritativeCommandEnvelope,
    failureReason: string
  ) {
    if (!failureReason) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Task failure requires a reason"
      );
    }

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "failed",
      command,
      triggeringEvent: "task-failed",
      patch: () => ({ failureReason })
    });
  }

  cancel(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "cancelled",
      command,
      triggeringEvent: "task-cancelled"
    });
  }
}
