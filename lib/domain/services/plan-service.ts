import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  assertAuthorizationGrantEnvelope,
  type AuthorizationGrant,
  type AuthorizationGrantStore
} from "@/lib/authorization/grants";
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
  planVersion: number;
  planHash: string;
  requestedCapabilities: readonly string[];
  validationEvidenceId?: string;
  validationErrors: readonly string[];
  authorizationGrantId?: string;
  authorizationGrantHash?: string;
  compiledGraphId?: string;
}

export interface PlanStores {
  plans: EntityStore<PlanRecord>;
  authorizationGrants: AuthorizationGrantStore;
}

function sameCapabilities(left: readonly string[], right: readonly string[]) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export class PlanService {
  constructor(
    private readonly transactions: ControlPlaneTransactionManager<PlanStores>,
    private readonly now: () => Date = () => new Date()
  ) {}

  beginValidation(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.plans,
      entityType: "plan",
      entityId: id,
      to: "validating",
      command,
      triggeringEvent: "plan-validation-started",
      now: this.now
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
      metadata: () => ({ validationEvidenceId: evidenceId }),
      now: this.now
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
      patch: () => ({ validationErrors: [...errors] }),
      now: this.now
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
      triggeringEvent: "plan-authorization-requested",
      now: this.now
    });
  }

  authorize(id: string, command: AuthoritativeCommandEnvelope, grant: AuthorizationGrant) {
    assertAuthorizationGrantEnvelope(grant, command.scope, this.now().getTime());
    if (grant.planId !== id) {
      throw new ControlPlaneError("FORBIDDEN", "Authorization grant belongs to a different plan");
    }
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.plans,
      entityType: "plan",
      entityId: id,
      to: "authorized",
      command,
      triggeringEvent: "plan-authorized",
      beforeTransition: async (current, transaction) => {
        if (
          current.planVersion !== grant.planVersion
          || current.planHash !== grant.planHash
          || !sameCapabilities(current.requestedCapabilities, grant.capabilityNames)
        ) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Authorization grant does not match the current authoritative plan version, hash, or capabilities"
          );
        }

        const persistedGrant = await transaction.stores.authorizationGrants.get(grant.id);
        if (!persistedGrant || persistedGrant.grantHash !== grant.grantHash) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Authorization grant is missing or differs from authoritative storage"
          );
        }
        assertAuthorizationGrantEnvelope(
          persistedGrant,
          command.scope,
          this.now().getTime()
        );
      },
      patch: () => ({
        authorizationGrantId: grant.id,
        authorizationGrantHash: grant.grantHash
      }),
      metadata: () => ({
        authorizationGrantId: grant.id,
        authorizationGrantHash: grant.grantHash
      }),
      now: this.now
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
      metadata: () => ({ compiledGraphId }),
      now: this.now
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
      triggeringEvent: "plan-cancelled",
      now: this.now
    });
  }
}
