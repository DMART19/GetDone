import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import {
  assertAuthorizationGrantEnvelope,
  createAuthorizationConsumptionRecord,
  type AuthorizationConsumptionRecord,
  type AuthorizationGrant
} from "@/lib/authorization/grants";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
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
  failureReason?: string;
}

export interface JobStores {
  jobs: EntityStore<JobRecord>;
}

export class JobService {
  constructor(private readonly transactions: ControlPlaneTransactionManager<JobStores>) {}

  queue(
    id: string,
    command: AuthoritativeCommandEnvelope,
    grant: AuthorizationGrant,
    consumedAt = new Date().toISOString()
  ) {
    assertAuthorizationGrantEnvelope(grant, command.scope, Date.parse(consumedAt));

    const consumption = createAuthorizationConsumptionRecord({
      id: `authorization-consumption:${grant.id}`,
      grant,
      consumerType: "job",
      consumerId: id,
      consumedAt
    });

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "queued",
      command,
      triggeringEvent: "job-queued",
      patch: () => ({
        authorizationGrantId: grant.id,
        authorizationGrantHash: grant.grantHash,
        authorizationConsumption: consumption
      }),
      metadata: () => ({
        authorizationGrantId: grant.id,
        authorizationConsumptionHash: consumption.consumptionHash
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
            "Job cannot be claimed without persisted authorization consumption"
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
            "Job authorization consumption is missing"
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

  succeed(id: string, command: AuthoritativeCommandEnvelope, evidenceIds: readonly string[]) {
    if (evidenceIds.length === 0) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Job success requires independent verification evidence"
      );
    }
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "succeeded",
      command,
      triggeringEvent: "job-verified-succeeded",
      patch: () => ({ verificationEvidenceIds: [...evidenceIds] })
    });
  }

  markUncertain(id: string, command: AuthoritativeCommandEnvelope, evidenceIds: readonly string[]) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.jobs,
      entityType: "job",
      entityId: id,
      to: "uncertain",
      command,
      triggeringEvent: "job-verification-uncertain",
      patch: () => ({ verificationEvidenceIds: [...evidenceIds] })
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
