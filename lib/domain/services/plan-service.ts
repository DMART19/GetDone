import type { AuditLedger } from "@/lib/domain/audit";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { RequestContext } from "@/lib/control-plane/request-context";
import {
  requireEntity,
  transitionEntity,
  type EntityStore,
  type StatefulEntity
} from "@/lib/domain/services/common";

export type PlanState =
  | "proposed"
  | "validating"
  | "validated"
  | "awaiting-authorization"
  | "authorized"
  | "compiled"
  | "rejected"
  | "cancelled";

export interface PlanRecord extends StatefulEntity {
  state: PlanState;
  goalId?: string;
  requestedCapabilities: readonly string[];
  validationEvidenceId?: string;
  validationErrors: readonly string[];
  authorizationId?: string;
  compiledGraphId?: string;
}

export class PlanService {
  constructor(
    private readonly store: EntityStore<PlanRecord>,
    private readonly audit: AuditLedger
  ) {}

  async beginValidation(id: string, request: RequestContext) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity("plan", current, "validating", { request, triggeringEvent: "plan-validation-started" }, this.store, this.audit);
  }

  async markValidated(id: string, request: RequestContext, evidenceId: string) {
    if (!evidenceId) throw new ControlPlaneError("VALIDATION_FAILED", "Validation evidence is required");
    const current = await requireEntity(this.store, id, request);
    if (current.validationErrors.length > 0) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Plan with validation errors cannot be marked validated");
    }
    return transitionEntity(
      "plan",
      current,
      "validated",
      { request, triggeringEvent: "plan-validation-passed" },
      this.store,
      this.audit,
      { validationEvidenceId: evidenceId },
      { validationEvidenceId: evidenceId }
    );
  }

  async reject(id: string, request: RequestContext, errors: readonly string[]) {
    if (errors.length === 0) throw new ControlPlaneError("VALIDATION_FAILED", "A rejected plan requires at least one validation error");
    const current = await requireEntity(this.store, id, request);
    return transitionEntity(
      "plan",
      current,
      "rejected",
      { request, triggeringEvent: "plan-validation-rejected" },
      this.store,
      this.audit,
      { validationErrors: [...errors] }
    );
  }

  async requestAuthorization(id: string, request: RequestContext) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity("plan", current, "awaiting-authorization", { request, triggeringEvent: "plan-authorization-requested" }, this.store, this.audit);
  }

  async authorize(id: string, request: RequestContext, authorizationId: string) {
    if (!authorizationId) throw new ControlPlaneError("VALIDATION_FAILED", "Authorization lineage is required");
    const current = await requireEntity(this.store, id, request);
    return transitionEntity(
      "plan",
      current,
      "authorized",
      { request, triggeringEvent: "plan-authorized" },
      this.store,
      this.audit,
      { authorizationId },
      { authorizationId }
    );
  }

  async compile(id: string, request: RequestContext, compiledGraphId: string) {
    if (!compiledGraphId) throw new ControlPlaneError("VALIDATION_FAILED", "Compiled graph reference is required");
    const current = await requireEntity(this.store, id, request);
    return transitionEntity(
      "plan",
      current,
      "compiled",
      { request, triggeringEvent: "plan-compiled" },
      this.store,
      this.audit,
      { compiledGraphId },
      { compiledGraphId }
    );
  }

  async cancel(id: string, request: RequestContext) {
    const current = await requireEntity(this.store, id, request);
    return transitionEntity("plan", current, "cancelled", { request, triggeringEvent: "plan-cancelled" }, this.store, this.audit);
  }
}
