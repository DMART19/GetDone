import type { GetDoneEnvironment, TrustedActor, TrustedScope } from "@/lib/control-plane/request-context";

export interface AuditEvent {
  id: string;
  correlationId: string;
  eventType: string;
  actor: TrustedActor;
  scope: TrustedScope;
  environment: GetDoneEnvironment;
  entityType: string;
  entityId: string;
  previousState?: string;
  newState?: string;
  provenance: string;
  occurredAt: string;
  metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AuditLedger {
  append(event: AuditEvent): Promise<void>;
  listByCorrelationId(correlationId: string): Promise<readonly AuditEvent[]>;
}

export function createAuditEvent(input: Omit<AuditEvent, "id" | "occurredAt">): AuditEvent {
  return Object.freeze({
    ...input,
    id: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    metadata: Object.freeze({ ...input.metadata })
  });
}
