import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import {
  executeTransitionCommand,
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

export interface PlanStores {
  plans: EntityStore<PlanRecord>;
}

export class PlanService {
  constructor(private readonly transactions: ControlPlaneTransactionManager<PlanStores>) {}

  beginValidation(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.plans,
      entityType: "plan",
      entityId: id,
      to: "validating",
      command,
      triggeringEvent: "plan-validation-started"
    });
  }

  markValidated(id: string, command: AuthoritativeCommandEnvelope, evidenceId: string) {
    if (!evidenceId) throw new ControlPlaneError("VALIDATION_FAILED", "Validation evidence is required");
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.plans,
      entityType: "plan",
      entityId: id,
      to: "validated",
      command,
      triggeringEvent: "plan-validation-passed",
      patch: (current) => {
        if (current.validationErrors.length > 0) {
          throw new ControlPlaneError("VALIDATION_FAILED", "Plan with validation errors cannot be marked validated");
        }
        return { validationEvidenceId: evidenceId };
      },
      metadata: () => ({ validationEvidenceId: evidenceId })
    });
  }

  reject(id: string, command: AuthoritativeCommandEnvelope, errors: readonly string[]) {
    if (errors.length === 0) {
      throw new ControlPlaneError("VALIDATION_FAILED", "A rejected plan requires at least one validation error");
    }
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.plans,
      entityType: "plan",
      entityId: id,
      to: "rejected",
      command,
      triggeringEvent: "plan-validation-rejected",
      patch: () => ({ validationErrors: [...errors] })
    });
  }

  requestAuthorization(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.plans,
      entityType: "plan",
      entityId: id,
      to: "awaiting-authorization",
      command,
      triggeringEvent: "plan-authorization-requested"
    });
  }

  authorize(id: string, command: AuthoritativeCommandEnvelope, authorizationId: string) {
    if (!authorizationId) throw new ControlPlaneError("VALIDATION_FAILED", "Authorization lineage is required");
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.plans,
      entityType: "plan",
      entityId: id,
      to: "authorized",
      command,
      triggeringEvent: "plan-authorized",
      patch: () => ({ authorizationId }),
      metadata: () => ({ authorizationId })
    });
  }

  compile(id: string, command: AuthoritativeCommandEnvelope, compiledGraphId: string) {
    if (!compiledGraphId) throw new ControlPlaneError("VALIDATION_FAILED", "Compiled graph reference is required");
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.plans,
      entityType: "plan",
      entityId: id,
      to: "compiled",
      command,
      triggeringEvent: "plan-compiled",
      patch: () => ({ compiledGraphId }),
      metadata: () => ({ compiledGraphId })
    });
  }

  cancel(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.plans,
      entityType: "plan",
      entityId: id,
      to: "cancelled",
      command,
      triggeringEvent: "plan-cancelled"
    });
  }
}
