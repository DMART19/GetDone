import { ControlPlaneError } from "@/lib/control-plane/errors";
import { assertAuthorizationGrantEnvelope, type AuthorizationGrant } from "@/lib/authorization/grants";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import {
  executeTransitionCommand,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";

export type TaskState = "proposed" | "authorized" | "queued" | "running" | "verifying" | "succeeded" | "failed" | "uncertain" | "cancelled";

export interface TaskRecord extends StatefulEntity {
  state: TaskState;
  reason: string;
  evidenceIds: readonly string[];
  capabilityRequirements: readonly string[];
  authorizationLineage: readonly string[];
  authorizationGrantId?: string;
  authorizationGrantHash?: string;
  verificationEvidenceIds: readonly string[];
  failureReason?: string;
}

export interface TaskStores {
  tasks: EntityStore<TaskRecord>;
}

export class TaskService {
  constructor(private readonly transactions: ControlPlaneTransactionManager<TaskStores>) {}

  authorize(id: string, command: AuthoritativeCommandEnvelope, grant: AuthorizationGrant) {
    assertAuthorizationGrantEnvelope(grant, command.scope);
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.tasks,
      entityType: "task",
      entityId: id,
      to: "authorized",
      command,
      triggeringEvent: "task-authorized",
      beforeTransition: undefined,
      patch: (current) => {
        const required = [...new Set(current.capabilityRequirements)].sort();
        const granted = [...new Set(grant.capabilityNames)].sort();
        if (required.length !== granted.length || required.some((item, index) => item !== granted[index])) {
          throw new ControlPlaneError("FORBIDDEN", "Authorization grant capabilities do not match the task requirements");
        }
        return {
          authorizationLineage: [...current.authorizationLineage, grant.id],
          authorizationGrantId: grant.id,
          authorizationGrantHash: grant.grantHash
        };
      },
      metadata: () => ({
        authorizationGrantId: grant.id,
        authorizationGrantHash: grant.grantHash
      })
    });
  }

  queue(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({ manager: this.transactions, selectStore: (stores) => stores.tasks, entityType: "task", entityId: id, to: "queued", command, triggeringEvent: "task-queued" });
  }

  start(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({ manager: this.transactions, selectStore: (stores) => stores.tasks, entityType: "task", entityId: id, to: "running", command, triggeringEvent: "task-started" });
  }

  beginVerification(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({ manager: this.transactions, selectStore: (stores) => stores.tasks, entityType: "task", entityId: id, to: "verifying", command, triggeringEvent: "task-verification-started" });
  }

  succeed(id: string, command: AuthoritativeCommandEnvelope, evidenceIds: readonly string[]) {
    if (evidenceIds.length === 0) throw new ControlPlaneError("VALIDATION_FAILED", "Task success requires verification evidence");
    return executeTransitionCommand({
      manager: this.transactions, selectStore: (stores) => stores.tasks, entityType: "task", entityId: id, to: "succeeded", command,
      triggeringEvent: "task-verified-succeeded", patch: () => ({ verificationEvidenceIds: [...evidenceIds] })
    });
  }

  markUncertain(id: string, command: AuthoritativeCommandEnvelope, evidenceIds: readonly string[]) {
    return executeTransitionCommand({
      manager: this.transactions, selectStore: (stores) => stores.tasks, entityType: "task", entityId: id, to: "uncertain", command,
      triggeringEvent: "task-verification-uncertain", patch: () => ({ verificationEvidenceIds: [...evidenceIds] })
    });
  }

  fail(id: string, command: AuthoritativeCommandEnvelope, failureReason: string) {
    if (!failureReason) throw new ControlPlaneError("VALIDATION_FAILED", "Task failure requires a reason");
    return executeTransitionCommand({
      manager: this.transactions, selectStore: (stores) => stores.tasks, entityType: "task", entityId: id, to: "failed", command,
      triggeringEvent: "task-failed", patch: () => ({ failureReason })
    });
  }

  cancel(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({ manager: this.transactions, selectStore: (stores) => stores.tasks, entityType: "task", entityId: id, to: "cancelled", command, triggeringEvent: "task-cancelled" });
  }
}
