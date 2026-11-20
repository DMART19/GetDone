import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { redactTelemetryText } from "@/lib/observability/telemetry";
import { evidenceSchema, type NormalizedEvidence, type OperationScope } from "./contracts";

export function safeOperationalLink(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "/") return value;
  if (/^\/(?!\/)[A-Za-z0-9/%_.:-]+$/.test(value)) {
    try {
      const decoded = decodeURIComponent(value);
      if (!decoded.startsWith("//") && !decoded.split("/").some(part => part === "." || part === "..")) return value;
    } catch { return undefined; }
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
    if (!["github.com", "dashboard.render.com", "supabase.com"].includes(url.hostname)) return undefined;
    return url.toString();
  } catch { return undefined; }
}
export function normalizeEvidence(input: Omit<NormalizedEvidence, "contentHash">): NormalizedEvidence {
  const safeFacts = Object.fromEntries(Object.entries(input.facts).filter(([key]) =>
    !/secret|password|token|credential|authorization|cookie|private.?key/i.test(key)).map(([key, value]) =>
    [key, typeof value === "string" ? redactTelemetryText(value) : value]));
  const base = { ...input, summary: redactTelemetryText(input.summary), facts: safeFacts,
    deepLink: safeOperationalLink(input.deepLink), providerMetadata: undefined };
  return evidenceSchema.parse({ ...base, contentHash: sha256Hex(base) });
}
export function authorizedEvidence(rows: readonly NormalizedEvidence[], scope: OperationScope, topic: string | undefined,
  allowedSensitivity: readonly NormalizedEvidence["sensitivity"][], now: number, allowedResources?: readonly string[]) {
  return rows.filter(raw => {
    const parsed = evidenceSchema.safeParse(raw);
    if (!parsed.success) return false;
    const { contentHash, ...base } = parsed.data;
    return contentHash === sha256Hex(base)
      && raw.portfolioId === scope.portfolioId && raw.companyId === scope.companyId && raw.environment === scope.environment
      && raw.authorization.grantedUserIds.includes(scope.userId) && allowedSensitivity.includes(raw.sensitivity)
      && (!scope.resourceId || scope.resourceId === raw.authorization.resourceId)
      && (!allowedResources || allowedResources.includes(raw.authorization.resourceId))
      && (!topic || topic === "health" || raw.topic === topic)
      && Date.parse(raw.authorization.authorizedAt) <= now && Date.parse(raw.observedAt) <= now && Date.parse(raw.freshUntil) > now;
  }).sort((a, b) => b.confidence - a.confidence || b.observedAt.localeCompare(a.observedAt) || a.evidenceId.localeCompare(b.evidenceId));
}
