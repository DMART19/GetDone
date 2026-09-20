import type { AuditLedger } from "@/lib/domain/audit";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { RequestContext } from "@/lib/control-plane/request-context";
import {
  requireEntity,
  transitionEntity,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";

export type ApprovalState = "pending" | "granted" | "denied" | "expired";

export interface ApprovalRecord extends StatefulEntity {
  state: ApprovalState;
  decisionId: string;
  requirement: "approval" | "strong-approval";
  grantedBy?: string;
  deniedBy?: string;
}

export class ApprovalService {
  constructor(
    private readonly store: EntityStore<ApprovalRecord>,
    private readonly audit: AuditLedger
  ) {}

  async grant(id: string, request: RequestContext, stepUpSatisfied: boolean) {
    const current = await requireEntity(this.store, id, request);
    if (current.requirement === "strong-approval" && !stepUpSatisfied) {
      throw new ControlPlaneError("FORBIDDEN", "Fresh step-up authentication is required for strong approval");
    }
    return transitionEntity(
      "approval",
      current,
      "granted",
      { request, triggeringEvent: "approval-granted" },
      this.store,
      this.audit,
      { grantedBy: request.actor.id },
      { requirement: current.requirement }
    );
  }

  async deny(id: string, request: RequestContext) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity(
      "approval",
      current,
      "denied",
      { request, triggeringEvent: "approval-denied" },
      this.store,
      this.audit,
      { deniedBy: request.actor.id }
    );
  }

  async expire(id: string, request: RequestContext) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity("approval", current, "expired", { request, triggeringEvent: "approval-expired" }, this.store, this.audit);
  }
}
