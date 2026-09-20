import { createAuditEvent } from "@/lib/domain/audit";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { commandFingerprint } from "@/lib/control-plane/command-envelope";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import { claimIdempotency } from "@/lib/domain/idempotency";
import { assertTransition, type StateMachineEntity } from "@/lib/domain/state-machine";

export interface TransitionEntity {
  id: string;
  portfolioId: string;
  companyId: string;
  version: number;
  updatedAt: string;
}

export interface TransitionEntityStore<T extends TransitionEntity> {
  get(id: string): Promise<T | null>;
  save(next: T, expectedVersion: number): Promise<void>;
}

export interface AuthoritativeTransitionInput<T extends TransitionEntity, TStores> {
  manager: ControlPlaneTransactionManager<TStores>;
  selectStore: (stores: TStores) => TransitionEntityStore<T>;
  entityType: StateMachineEntity;
  entityId: string;
  to: string;
  command: AuthoritativeCommandEnvelope;
  triggeringEvent: string;
  stateOf: (entity: T) => string;
  applyState: (entity: T, nextState: string) => T;
  beforeTransition?: (current: T) => void | Promise<void>;
  patch?: (current: T) => Partial<T> | Record<string, unknown>;
  metadata?: (current: T) => Readonly<Record<string, string | number | boolean | null>>;
  now?: () => Date;
}

export function assertTransitionEntityScope(
  entity: TransitionEntity,
  command: AuthoritativeCommandEnvelope
) {
  if (
    entity.portfolioId !== command.scope.portfolioId
    || entity.companyId !== command.scope.companyId
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Entity is outside the trusted command scope", {
      correlationId: command.correlationId
    });
  }
}

export class AuthoritativeTransitionService {
  async transition<T extends TransitionEntity, TStores>(
    input: AuthoritativeTransitionInput<T, TStores>
  ): Promise<T> {
    const fingerprint = commandFingerprint(input.command);
    const now = input.now ?? (() => new Date());

    return input.manager.run(async (transaction) => {
      const claim = await claimIdempotency<T>(
        transaction.idempotency,
        input.command.idempotencyKey,
        fingerprint,
        now()
      );

      if (claim.state === "COMPLETED" && claim.record.result) return claim.record.result;
      if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
        throw new ControlPlaneError(
          "CONFLICT",
          "The authoritative command is already in progress or previously failed",
          { correlationId: input.command.correlationId }
        );
      }

      const store = input.selectStore(transaction.stores);
      const current = await store.get(input.entityId);
      if (!current) {
        throw new ControlPlaneError("NOT_FOUND", "Authoritative entity was not found", {
          correlationId: input.command.correlationId
        });
      }

      assertTransitionEntityScope(current, input.command);
      const from = input.stateOf(current);
      assertTransition(input.entityType, from, input.to);
      await input.beforeTransition?.(current);

      const patched = {
        ...current,
        ...(input.patch?.(current) ?? {}),
        version: current.version + 1,
        updatedAt: now().toISOString()
      } as T;
      const next = input.applyState(patched, input.to);

      await store.save(next, current.version);
      await transaction.audit.append(createAuditEvent({
        correlationId: input.command.correlationId,
        eventType: `${input.entityType}.${input.to}`,
        actor: input.command.actor,
        scope: {
          userId: input.command.scope.userId,
          portfolioId: input.command.scope.portfolioId,
          companyId: input.command.scope.companyId,
          resourceId: input.command.scope.resourceId
        },
        environment: input.command.environment,
        entityType: input.entityType,
        entityId: current.id,
        previousState: from,
        newState: input.to,
        provenance: input.command.provenance,
        metadata: {
          commandId: input.command.commandId,
          idempotencyKey: input.command.idempotencyKey,
          triggeringEvent: input.triggeringEvent,
          ...(input.metadata?.(current) ?? {})
        }
      }));

      await transaction.idempotency.complete(
        input.command.idempotencyKey,
        fingerprint,
        next,
        now().toISOString()
      );

      return next;
    });
  }
}

export const authoritativeTransitionService = new AuthoritativeTransitionService();
