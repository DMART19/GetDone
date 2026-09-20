import { createAuditEvent } from "@/lib/domain/audit";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { commandFingerprint } from "@/lib/control-plane/command-envelope";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import { claimIdempotency } from "@/lib/domain/idempotency";
import { assertTransition, type StateMachineEntity } from "@/lib/domain/state-machine";

export interface AuthoritativeEntity {
  id: string;
  portfolioId: string;
  companyId: string;
  version: number;
  updatedAt: string;
}

export interface StatefulEntity extends AuthoritativeEntity {
  state: string;
}

export interface EntityStore<T extends AuthoritativeEntity> {
  get(id: string): Promise<T | null>;
  save(next: T, expectedVersion: number): Promise<void>;
}

export function assertEntityScope(entity: AuthoritativeEntity, command: AuthoritativeCommandEnvelope) {
  if (
    entity.portfolioId !== command.scope.portfolioId
    || entity.companyId !== command.scope.companyId
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Entity is outside the trusted command scope", {
      correlationId: command.correlationId
    });
  }
}

export async function requireEntity<T extends AuthoritativeEntity>(
  store: EntityStore<T>,
  id: string,
  command: AuthoritativeCommandEnvelope
) {
  const entity = await store.get(id);
  if (!entity) {
    throw new ControlPlaneError("NOT_FOUND", "Authoritative entity was not found", {
      correlationId: command.correlationId
    });
  }
  assertEntityScope(entity, command);
  return entity;
}

export async function executeTransitionCommand<T extends StatefulEntity, TStores>(input: {
  manager: ControlPlaneTransactionManager<TStores>;
  selectStore: (stores: TStores) => EntityStore<T>;
  entityType: StateMachineEntity;
  entityId: string;
  to: string;
  command: AuthoritativeCommandEnvelope;
  triggeringEvent: string;
  patch?: (current: T) => Partial<T>;
  metadata?: (current: T) => Readonly<Record<string, string | number | boolean | null>>;
}): Promise<T> {
  const fingerprint = commandFingerprint(input.command);

  return input.manager.run(async (transaction) => {
    const claim = await claimIdempotency<T>(
      transaction.idempotency,
      input.command.idempotencyKey,
      fingerprint
    );

    if (claim.state === "COMPLETED" && claim.record.result) return claim.record.result;
    if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
      throw new ControlPlaneError("CONFLICT", "The authoritative command is already in progress or previously failed", {
        correlationId: input.command.correlationId
      });
    }

    const store = input.selectStore(transaction.stores);
    const current = await requireEntity(store, input.entityId, input.command);
    assertTransition(input.entityType, current.state, input.to);

    const next = {
      ...current,
      ...(input.patch?.(current) ?? {}),
      state: input.to,
      version: current.version + 1,
      updatedAt: new Date().toISOString()
    } as T;

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
      previousState: current.state,
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
      new Date().toISOString()
    );

    return next;
  });
}
