import type { AuditLedger } from "@/lib/domain/audit";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { RequestContext } from "@/lib/control-plane/request-context";
import {
  requireEntity,
  transitionEntity,
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
  verificationEvidenceIds: readonly string[];
  failureReason?: string;
}

export class TaskService {
  constructor(
    private readonly store: EntityStore<TaskRecord>,
    private readonly audit: AuditLedger
  ) {}

  async authorize(id: string, request: RequestContext, authorizationId: string) {
    if (!authorizationId) throw new ControlPlaneError("VALIDATION_FAILED", "Task authorization lineage is required");
    const current = await requireEntity(this.store, id, request);
    return transitionEntity(
      "task",
      current,
      "authorized",
      { request, triggeringEvent: "task-authorized" },
      this.store,
      this.audit,
      { authorizationLineage: [...current.authorizationLineage, authorizationId] },
      { authorizationId }
    );
  }

  async queue(id: string, request: RequestContext) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity("task", current, "queued", { request, triggeringEvent: "task-queued" }, this.store, this.audit);
  }

  async start(id: string, request: RequestContext) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity("task", current, "running", { request, triggeringEvent: "task-started" }, this.store, this.audit);
  }

  async beginVerification(id: string, request: RequestContext) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity("task", current, "verifying", { request, triggeringEvent: "task-verification-started" }, this.store, this.audit);
  }

  async succeed(id: string, request: RequestContext, evidenceIds: readonly string[]) {
    if (evidenceIds.length === 0) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Task success requires verification evidence");
    }
    const current = await requireEntity(this.store, id, request);
    return transitionEntity(
      "task",
      current,
      "succeeded",
      { request, triggeringEvent: "task-verified-succeeded" },
      this.store,
      this.audit,
      { verificationEvidenceIds: [...evidenceIds] }
    );
  }

  async markUncertain(id: string, request: RequestContext, evidenceIds: readonly string[]) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity(
      "task",
      current,
      "uncertain",
      { request, triggeringEvent: "task-verification-uncertain" },
      this.store,
      this.audit,
      { verificationEvidenceIds: [...evidenceIds] }
    );
  }

  async fail(id: string, request: RequestContext, failureReason: string) {
    if (!failureReason) throw new ControlPlaneError("VALIDATION_FAILED", "Task failure requires a reason");
    const current = await requireEntity(this.store, id, request);
    return transitionEntity(
      "task",
      current,
      "failed",
      { request, triggeringEvent: "task-failed" },
      this.store,
      this.audit,
      { failureReason }
    );
  }

  async cancel(id: string, request: RequestContext) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity("task", current, "cancelled", { request, triggeringEvent: "task-cancelled" }, this.store, this.audit);
  }
}
