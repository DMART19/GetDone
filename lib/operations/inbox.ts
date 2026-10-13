import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { redactTelemetryText } from "@/lib/observability/telemetry";
import { inboxSchema, type OwnerInboxItem, type OperationScope } from "./contracts";
import { safeOperationalLink } from "./evidence";

export function inboxObjectId(scope: OperationScope, objectType: string, objectId: string) {
  return `owner-inbox:${sha256Hex({ ...scope, resourceId: undefined, objectType, objectId })}`;
}
export function actionableInbox(items: readonly OwnerInboxItem[], scope: OperationScope, now: number) {
  const deduplicated = new Map<string, OwnerInboxItem>();
  for (const raw of items) {
    const parsed = inboxSchema.safeParse(raw);
    if (!parsed.success) continue;
    const item = parsed.data;
    const href = safeOperationalLink(item.nextAction.href);
    if (item.state !== "open" || item.portfolioId !== scope.portfolioId || item.companyId !== scope.companyId
      || item.environment !== scope.environment || item.userId !== scope.userId || !href
      || !["public", "internal"].includes(item.sensitivity) || Date.parse(item.createdAt) > now
      || (item.kind === "recommendation" && item.confidence < 0.75)) continue;
    const key = inboxObjectId(scope, item.objectType, item.objectId);
    const previous = deduplicated.get(key);
    if (!previous || item.updatedAt > previous.updatedAt) deduplicated.set(key, { ...item, id: key,
      summary: redactTelemetryText(item.summary), nextAction: { label: redactTelemetryText(item.nextAction.label), href } });
  }
  const score = (i: OwnerInboxItem) => 4 * i.urgency + 3 * i.impact + i.confidence
    + Math.min(1, Math.max(0, now - Date.parse(i.createdAt)) / (7 * 86400_000));
  return [...deduplicated.values()].sort((a, b) => score(b) - score(a) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
export function isOwnerInputQuestion(message: string) {
  return /\b(?:what|which)\b.*\b(?:needs?|requires?|waiting for)\b.*\b(?:my|owner)\s+(?:input|decision|approval)\b/i.test(message);
}
