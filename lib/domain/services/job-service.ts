import type { AuditLedger } from "@/lib/domain/audit";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { RequestContext } from "@/lib/control-plane/request-context";
import {
  requireEntity,
  transitionEntity,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";

export type JobState = "created" | "queued" | "claimed" | "running" | "verifying" | "succeeded" | "failed" | "uncertain" | "cancelled";

export interface JobRecord extends StatefulEntity {
  state: JobState;
  taskId: string;
  workerId?: string;
  attempt: number;
  verificationEvidenceIds: readonly string[];
  failureReason?: string;
}

export class JobService {
  constructor(
    private readonly store: EntityStore<JobRecord>,
    private readonly audit: AuditLedger
  ) {}

  async queue(id: string, request: RequestContext) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity("job", current, "queued", { request, triggeringEvent: "job-queued" }, this.store, this.audit);
  }

  async claim(id: string, request: RequestContext, workerId: string) {
    if (!workerId) throw new ControlPlaneError("VALIDATION_FAILED", "Worker identity is required");
    const current = await requireEntity(this.store, id, request);
    return transitionEntity(
      "job",
      current,
      "claimed",
      { request, triggeringEvent: "job-claimed" },
      this.store,
      this.audit,
      { workerId, attempt: current.attempt + 1 },
      { workerId, attempt: current.attempt + 1 }
    );
  }

  async releaseClaim(id: string, request: RequestContext) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity(
      "job",
      current,
      "queued",
      { request, triggeringEvent: "job-claim-released" },
      this.store,
      this.audit,
      { workerId: undefined }
    );
  }

  async start(id: string, request: RequestContext) {
    const current = await requireEntity(this.store, id, request);
    if (!current.workerId) throw new ControlPlaneError("CONFLICT", "A claimed worker is required before job start");
    return transitionEntity("job", current, "running", { request, triggeringEvent: "job-started" }, this.store, this.audit);
  }

  async beginVerification(id: string, request: RequestContext) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity("job", current, "verifying", { request, triggeringEvent: "job-verification-started" }, this.store, this.audit);
  }

  async succeed(id: string, request: RequestContext, evidenceIds: readonly string[]) {
    if (evidenceIds.length === 0) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Job success requires independent verification evidence");
    }
    const current = await requireEntity(this.store, id, request);
    return transitionEntity(
      "job",
      current,
      "succeeded",
      { request, triggeringEvent: "job-verified-succeeded" },
      this.store,
      this.audit,
      { verificationEvidenceIds: [...evidenceIds] }
    );
  }

  async markUncertain(id: string, request: RequestContext, evidenceIds: readonly string[]) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity(
      "job",
      current,
      "uncertain",
      { request, triggeringEvent: "job-verification-uncertain" },
      this.store,
      this.audit,
      { verificationEvidenceIds: [...evidenceIds] }
    );
  }

  async fail(id: string, request: RequestContext, failureReason: string) {
    if (!failureReason) throw new ControlPlaneError("VALIDATION_FAILED", "Job failure requires a reason");
    const current = await requireEntity(this.store, id, request);
    return transitionEntity(
      "job",
      current,
      "failed",
      { request, triggeringEvent: "job-failed" },
      this.store,
      this.audit,
      { failureReason }
    );
  }

  async cancel(id: string, request: RequestContext) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity("job", current, "cancelled", { request, triggeringEvent: "job-cancelled" }, this.store, this.audit);
  }
}
