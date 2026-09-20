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

export interface RawEvent {
  source: string;
  externalId?: string;
  companyId: string;
  resourceId?: string;
  type: string;
  occurredAt: string;
  receivedAt: string;
  value?: number;
  baseline?: number;
  severity?: "info" | "low" | "medium" | "high" | "critical";
  expected?: boolean;
  sustainedForSeconds?: number;
}

export interface NormalizedSignal extends RawEvent {
  dedupeKey: string;
  classification: SignalClass;
  action: AttentionAction;
  provenance: string;
}

export interface SignalAttentionWindow {
  now: number;
  maxAgeMs: number;
  cooldownMs: number;
  lastInvestigatedAt?: number;
}

export function signalDedupeKey(event: RawEvent) {
  return [
    event.source,
    event.externalId ?? event.type,
    event.companyId,
    event.resourceId ?? "-",
    event.occurredAt
  ].join(":");
}

export function classifySignal(event: RawEvent): Pick<NormalizedSignal, "classification" | "action"> {
  if (event.expected) return { classification: "expected", action: "RECORD" };

  if (event.severity === "critical") return { classification: "incident", action: "ESCALATE" };
  if (event.severity === "high") return { classification: "risk", action: "INVESTIGATE" };

  const hasNumbers = typeof event.value === "number" && typeof event.baseline === "number";
  if (hasNumbers) {
    const baseline = Math.max(Math.abs(event.baseline as number), 0.0001);
    const deltaRatio = Math.abs((event.value as number) - (event.baseline as number)) / baseline;

    if (deltaRatio >= 1 && (event.sustainedForSeconds ?? 0) >= 300) {
      return { classification: "anomaly", action: "ESCALATE" };
    }
    if (deltaRatio >= 0.5) return { classification: "anomaly", action: "INVESTIGATE" };
    if (deltaRatio >= 0.2) return { classification: "threshold", action: "MONITOR" };
  }

  if (event.severity === "medium") return { classification: "threshold", action: "MONITOR" };
  if (event.severity === "low") return { classification: "informational", action: "RECORD" };
  return { classification: "informational", action: "IGNORE" };
}

export function normalizeEvent(event: RawEvent): NormalizedSignal {
  const decision = classifySignal(event);
  return {
    ...event,
    ...decision,
    dedupeKey: signalDedupeKey(event),
    provenance: `${event.source}:${event.externalId ?? "unkeyed"}`
  };
}

export function isSignalFresh(signal: NormalizedSignal, now: number, maxAgeMs: number) {
  const occurredAt = Date.parse(signal.occurredAt);
  return Number.isFinite(occurredAt) && occurredAt <= now && now - occurredAt <= maxAgeMs;
}

export function shouldOpenInvestigation(signal: NormalizedSignal, window: SignalAttentionWindow) {
  if (!isSignalFresh(signal, window.now, window.maxAgeMs)) return false;
  if (signal.action !== "INVESTIGATE" && signal.action !== "ESCALATE") return false;
  if (signal.action === "ESCALATE") return true;
  if (window.lastInvestigatedAt === undefined) return true;
  return window.now - window.lastInvestigatedAt >= window.cooldownMs;
}

export function dedupeSignals(signals: readonly NormalizedSignal[]) {
  const seen = new Set<string>();
  const result: NormalizedSignal[] = [];

  for (const signal of signals) {
    if (seen.has(signal.dedupeKey)) continue;
    seen.add(signal.dedupeKey);
    result.push(signal);
  }
  return result;
}
