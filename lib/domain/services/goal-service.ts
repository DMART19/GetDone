import type { AuditLedger } from "@/lib/domain/audit";
import type { RequestContext } from "@/lib/control-plane/request-context";
import {
  requireEntity,
  transitionEntity,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";

export type GoalState = "draft" | "active" | "paused" | "completed" | "cancelled";

export interface GoalRecord extends StatefulEntity {
  state: GoalState;
  title: string;
  metric: string;
  target: number;
  priority: number;
  deadline?: string;
}

export class GoalService {
  constructor(
    private readonly store: EntityStore<GoalRecord>,
    private readonly audit: AuditLedger
  ) {}

  private async move(id: string, to: GoalState, request: RequestContext, triggeringEvent: string) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity("goal", current, to, { request, triggeringEvent }, this.store, this.audit);
  }

  activate(id: string, request: RequestContext) {
    return this.move(id, "active", request, "goal-activated");
  }

  pause(id: string, request: RequestContext) {
    return this.move(id, "paused", request, "goal-paused");
  }

  complete(id: string, request: RequestContext) {
    return this.move(id, "completed", request, "goal-completed");
  }

  cancel(id: string, request: RequestContext) {
    return this.move(id, "cancelled", request, "goal-cancelled");
  }
}
