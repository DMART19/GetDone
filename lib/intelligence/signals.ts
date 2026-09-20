export const resourceSignalTypes = [
  "resource.added",
  "resource.ready",
  "resource.offline",
  "resource.degraded",
  "resource.saturated",
  "resource.capacity-low",
  "resource.cost-spike",
  "resource.failover",
  "resource.credential-failure",
  "resource.policy-violation",
  "resource.drain-started",
  "resource.drain-complete"
] as const;

export type ResourceSignalType = (typeof resourceSignalTypes)[number];
export type SignalSeverity = "info" | "low" | "medium" | "high" | "critical";
export type SignalClass =
  | "informational"
  | "expected"
  | "threshold"
  | "anomaly"
  | "trend"
  | "opportunity"
  | "risk"
  | "goal-drift"
  | "incident";

export type AttentionAction = "IGNORE" | "RECORD" | "MONITOR" | "INVESTIGATE" | "ESCALATE";

export interface TrustedSignalScope {
  portfolioId: string;
  companyId: string;
  resourceId?: string;
}

export interface InboundSignalEvent {
  eventId: string;
  streamKey: string;
  type: string;
  occurredAt: string;
  sequence?: number;
  externalResourceRef?: string;
  metric?: string;
  value?: number;
  unit?: string;
  severity?: SignalSeverity;
  expected?: boolean;
  sustainedForSeconds?: number;
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface NormalizedSignal {
  id: string;
  dedupeKey: string;
  sourceBindingId: string;
  eventId: string;
  streamKey: string;
  sequence?: number;
  type: string;
  occurredAt: string;
  receivedAt: string;
  scope: TrustedSignalScope;
  metric?: string;
  value?: number;
  unit?: string;
  severity?: SignalSeverity;
  expected?: boolean;
  sustainedForSeconds?: number;
  attributes: Readonly<Record<string, string | number | boolean | null>>;
  provenance: string;
  outOfOrder: boolean;
}

export interface SensedSignal extends NormalizedSignal {
  classification: SignalClass;
  action: AttentionAction;
  sensingProfileId?: string;
  rationale: readonly string[];
}

export function isResourceSignalType(value: string): value is ResourceSignalType {
  return (resourceSignalTypes as readonly string[]).includes(value);
}

export function signalDedupeKey(
  sourceBindingId: string,
  eventId: string,
  scope: TrustedSignalScope
) {
  return [
    sourceBindingId,
    scope.portfolioId,
    scope.companyId,
    scope.resourceId ?? "-",
    eventId
  ].join(":");
}

export function signalStreamCursorKey(
  sourceBindingId: string,
  streamKey: string,
  scope: TrustedSignalScope
) {
  return [
    sourceBindingId,
    scope.portfolioId,
    scope.companyId,
    scope.resourceId ?? "-",
    streamKey
  ].join(":");
}
