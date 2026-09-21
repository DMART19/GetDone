import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type {
  ControlPlaneTransaction,
  ControlPlaneTransactionManager
} from "@/lib/domain/control-plane-transaction";
import type { StateMachineEntity } from "@/lib/domain/state-machine";
import {
  authoritativeTransitionService,
  assertTransitionEntityScope,
  type TransitionEntity,
  type TransitionEntityStore
} from "@/lib/domain/services/transition-service";

export type AuthoritativeEntity = TransitionEntity;
export type EntityStore<T extends AuthoritativeEntity> = TransitionEntityStore<T>;

export interface StatefulEntity extends AuthoritativeEntity {
  state: string;
}

export const assertEntityScope = assertTransitionEntityScope;

export async function requireEntity<T extends AuthoritativeEntity>(
  store: EntityStore<T>,
  id: string,
  command: AuthoritativeCommandEnvelope
) {
  const entity = await store.get(id);
  if (!entity) {
    const { ControlPlaneError } = await import("@/lib/control-plane/errors");
    throw new ControlPlaneError("NOT_FOUND", "Authoritative entity was not found", {
      correlationId: command.correlationId
    });
  }
  assertEntityScope(entity, command);
  return entity;
}

export function executeTransitionCommand<T extends StatefulEntity, TStores>(input: {
  manager: ControlPlaneTransactionManager<TStores>;
  selectStore: (stores: TStores) => EntityStore<T>;
  entityType: StateMachineEntity;
  entityId: string;
  to: string;
  command: AuthoritativeCommandEnvelope;
  triggeringEvent: string;
  beforeTransition?: (
    current: T,
    transaction: ControlPlaneTransaction<TStores>
  ) => void | Promise<void>;
  patch?: (
    current: T,
    transaction: ControlPlaneTransaction<TStores>
  ) => Partial<T> | Record<string, unknown> | Promise<Partial<T> | Record<string, unknown>>;
  metadata?: (current: T) => Readonly<Record<string, string | number | boolean | null>>;
  now?: () => Date;
}): Promise<T> {
  return authoritativeTransitionService.transition({
    ...input,
    stateOf: (entity) => entity.state,
    applyState: (entity, nextState) => ({ ...entity, state: nextState }) as T
  });
}
