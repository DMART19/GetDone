import type { RequestContext } from "@/lib/control-plane/request-context";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { createAuditEvent, type AuditLedger } from "@/lib/domain/audit";
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

export interface DomainMutationContext {
  request: RequestContext;
  triggeringEvent: string;
}

export function assertEntityScope(entity: AuthoritativeEntity, context: RequestContext) {
  if (
    entity.portfolioId !== context.scope.portfolioId
    || entity.companyId !== context.scope.companyId
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Entity is outside the trusted request scope", {
      correlationId: context.correlationId
    });
  }
}

export async function transitionEntity<T extends StatefulEntity>(
  entityType: StateMachineEntity,
  current: T,
  to: string,
  context: DomainMutationContext,
  store: EntityStore<T>,
  audit: AuditLedger,
  patch: Partial<T> = {},
  metadata: Readonly<Record<string, string | number | boolean | null>> = {}
): Promise<T> {
  assertEntityScope(current, context.request);
  assertTransition(entityType, current.state, to);

  const next = {
    ...current,
    ...patch,
    state: to,
    version: current.version + 1,
    updatedAt: new Date().toISOString()
  } as T;

  await store.save(next, current.version);
  await audit.append(createAuditEvent({
    correlationId: context.request.correlationId,
    eventType: `${entityType}.${to}`,
    actor: context.request.actor,
    scope: context.request.scope,
    environment: context.request.environment,
    entityType,
    entityId: current.id,
    previousState: current.state,
    newState: to,
    provenance: "getdone-control-plane",
    metadata: {
      triggeringEvent: context.triggeringEvent,
      ...metadata
    }
  }));

  return next;
}

export async function requireEntity<T extends AuthoritativeEntity>(
  store: EntityStore<T>,
  id: string,
  context: RequestContext
) {
  const entity = await store.get(id);
  if (!entity) {
    throw new ControlPlaneError("NOT_FOUND", "Authoritative entity was not found", {
      correlationId: context.correlationId
    });
  }
  assertEntityScope(entity, context);
  return entity;
}
