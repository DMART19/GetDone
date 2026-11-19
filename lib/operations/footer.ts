import { redactTelemetryText } from "@/lib/observability/telemetry";
import type { NormalizedEvidence } from "./contracts";
import { safeOperationalLink } from "./evidence";
export interface OperationalFooter {
  evidenceCount: number; freshness?: string; missing?: readonly string[]; confidence?: number;
  nextDecision?: string; deepLink?: string;
}
export function operationalFooter(evidence: readonly NormalizedEvidence[], input: {
  missing?: readonly string[]; nextDecision?: string; deepLink?: string;
} = {}): OperationalFooter {
  // Never copy facts, authorization provenance, provider metadata or resource payloads here.
  const safe = evidence.filter(e => ["public", "internal"].includes(e.sensitivity));
  return { evidenceCount: safe.length, freshness: safe.length ? safe.map(e => e.observedAt).sort()[0] : undefined,
    confidence: safe.length ? Math.min(...safe.map(e => e.confidence)) : undefined,
    missing: input.missing?.length ? input.missing.map(m => redactTelemetryText(m).slice(0, 300)) : undefined,
    nextDecision: input.nextDecision ? redactTelemetryText(input.nextDecision).slice(0, 300) : undefined,
    deepLink: safeOperationalLink(input.deepLink) };
}
