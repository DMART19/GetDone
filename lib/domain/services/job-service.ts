import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import {
  assertAuthorizationConsumption,
  assertAuthorizationGrantEnvelope,
  type AuthorizationConsumptionRecord,
  type AuthorizationGrant,
  type AuthorizationGrantStore
} from "@/lib/authorization/grants";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import {
  assertVerificationReceipt,
  type VerificationReceipt
} from "@/lib/verification/verification";
import {
  executeTransitionCommand,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";

export type JobState =
  | "created"
  | "queued"
  | "claimed"
  | "running"
  | "verifying"
  | "succeeded"
  | "failed"
  | "uncertain"
  | "cancelled";

export interface JobRecord extends StatefulEntity {
  state: JobState;
  taskId: string;
  workerId?: string;
  attempt: number;
  authorizationGrantId?: string;
  authorizationGrantHash?: string;
  authorizationConsumption?: AuthorizationConsumptionRecord;
  verificationEvidenceIds: readonly string[];
  verificationReceiptId?: string;
  verificationReceiptHash?: string;
  failureReason?: string;
}

export interface JobStores {
  jobs: EntityStore<JobRecord>;
  authorizationGrants?: AuthorizationGrantStore;
}

export class JobService {
  constructor(private readonly transactions: ControlPlaneTransactionManager<JobStores>) {}

  queue(
    id: string,
    command: AuthoritativeCommandEnvelope,
    grant: AuthorizationGrant,
    taskConsumption: AuthorizationConsumptionRecord,
    admittedAt = new Date().toISOString()
  ) {
    assertAuthorizationGrantEnvelope(grant, command.scope, Date.parse(admittedAt));
    assertAuthorizationConsumption(taskConsumption, grant);

    if (taskConsumption.consumerType !== "task") {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Jobs must inherit authorization from an already-authorized Task"
      );
    }

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "queued",
      command,
      triggeringEvent: "job-queued",
      patch: async (current, transaction) => {
        if (taskConsumption.consumerId !== current.taskId) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Authorization consumption belongs to a different parent Task"
          );
        }

        const grantStore = transaction.stores.authorizationGrants;
        if (!grantStore) {
          throw new ControlPlaneError(
            "UNAVAILABLE",
            "Authorization grant store is required before a job can be queued"
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
          Date.parse(admittedAt)
        );

        const persistedConsumptions = await grantStore.listConsumptions(grant.id);
        const persistedTaskConsumption = persistedConsumptions.find(
          (record) =>
            record.consumerType === "task"
            && record.consumerId === current.taskId
            && record.consumptionHash === taskConsumption.consumptionHash
        );
        if (!persistedTaskConsumption) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Parent Task authorization consumption is not authoritative"
          );
        }

        return {
          authorizationGrantId: grant.id,
          authorizationGrantHash: grant.grantHash,
          authorizationConsumption: persistedTaskConsumption
        };
      },
      metadata: () => ({
        authorizationGrantId: grant.id,
        inheritedTaskConsumptionHash: taskConsumption.consumptionHash
      })
    });
  }

  claim(id: string, command: AuthoritativeCommandEnvelope, workerId: string) {
    if (!workerId) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Worker identity is required");
    }
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "claimed",
      command,
      triggeringEvent: "job-claimed",
      patch: (current) => {
        if (!current.authorizationConsumption) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Job cannot be claimed without inherited authoritative Task authorization"
          );
        }
        return { workerId, attempt: current.attempt + 1 };
      },
      metadata: (current) => ({ workerId, attempt: current.attempt + 1 })
    });
  }

  releaseClaim(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "queued",
      command,
      triggeringEvent: "job-claim-released",
      patch: () => ({ workerId: undefined })
    });
  }

  start(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "running",
      command,
      triggeringEvent: "job-started",
      patch: (current) => {
        if (!current.workerId) {
          throw new ControlPlaneError(
            "CONFLICT",
            "A claimed worker is required before job start"
          );
        }
        if (!current.authorizationConsumption) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Job authorization lineage is missing"
          );
        }
        return {};
      }
    });
  }

  beginVerification(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "verifying",
      command,
      triggeringEvent: "job-verification-started"
    });
  }

  succeed(id: string, command: AuthoritativeCommandEnvelope, receipt: VerificationReceipt) {
    assertVerificationReceipt(receipt, {
      scope: command.scope,
      targetType: "job",
      targetId: id,
      expectedResult: "verified"
    });
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "succeeded",
      command,
      triggeringEvent: "job-verified-succeeded",
      patch: () => ({
        verificationEvidenceIds: [...receipt.evidenceIds],
        verificationReceiptId: receipt.id,
        verificationReceiptHash: receipt.receiptHash
      }),
      metadata: () => ({
        verificationReceiptId: receipt.id,
        verificationReceiptHash: receipt.receiptHash
      })
    });
  }

  markUncertain(id: string, command: AuthoritativeCommandEnvelope, receipt: VerificationReceipt) {
    assertVerificationReceipt(receipt, {
      scope: command.scope,
      targetType: "job",
      targetId: id,
      expectedResult: "uncertain"
    });
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "uncertain",
      command,
      triggeringEvent: "job-verification-uncertain",
      patch: () => ({
        verificationEvidenceIds: [...receipt.evidenceIds],
        verificationReceiptId: receipt.id,
        verificationReceiptHash: receipt.receiptHash
      }),
      metadata: () => ({
        verificationReceiptId: receipt.id,
        verificationReceiptHash: receipt.receiptHash
      })
    });
  }

  fail(id: string, command: AuthoritativeCommandEnvelope, failureReason: string) {
    if (!failureReason) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Job failure requires a reason");
    }
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "failed",
      command,
      triggeringEvent: "job-failed",
      patch: () => ({ failureReason })
    });
  }

  cancel(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "cancelled",
      command,
      triggeringEvent: "job-cancelled"
    });
  }
}
