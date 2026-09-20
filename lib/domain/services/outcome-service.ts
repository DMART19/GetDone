import type { AuditLedger } from "@/lib/domain/audit";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { RequestContext } from "@/lib/control-plane/request-context";
import {
  requireEntity,
  transitionEntity,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";

export type OutcomeState = "recorded" | "verified" | "uncertain" | "rejected";

export interface OutcomeRecord extends StatefulEntity {
  state: OutcomeState;
  objectiveId?: string;
  taskId?: string;
  jobId?: string;
  metric: string;
  value: number | string | boolean;
  evidenceIds: readonly string[];
  confidence?: number;
}

export class OutcomeService {
  constructor(
    private readonly store: EntityStore<OutcomeRecord>,
    private readonly audit: AuditLedger
  ) {}

  async verify(id: string, request: RequestContext, evidenceIds: readonly string[]) {
    if (evidenceIds.length === 0) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Verified outcomes require evidence");
    }
    const current = await requireEntity(this.store, id, request);
    return transitionEntity(
      "outcome",
      current,
      "verified",
      { request, triggeringEvent: "outcome-verified" },
      this.store,
      this.audit,
      { evidenceIds: [...evidenceIds] }
    );
  }

  async markUncertain(id: string, request: RequestContext, evidenceIds: readonly string[] = []) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity(
      "outcome",
      current,
      "uncertain",
      { request, triggeringEvent: "outcome-uncertain" },
      this.store,
      this.audit,
      { evidenceIds: [...evidenceIds] }
    );
  }

  async reject(id: string, request: RequestContext, evidenceIds: readonly string[] = []) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity(
      "outcome",
      current,
      "rejected",
      { request, triggeringEvent: "outcome-rejected" },
      this.store,
      this.audit,
      { evidenceIds: [...evidenceIds] }
    );
  }
}
