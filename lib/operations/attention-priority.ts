/** Deterministic advisory ranking, never execution admission. */
export interface AttentionPriority {
  urgency: number;
  impact: number;
  confidence: number;
  waitingForOwner?: boolean;
  blockedByDependency?: boolean;
  risk?: number;
  createdAt: string;
}
const clamp = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
/** Higher scores appear first; score is never an authorization token. */
export function attentionPriority(item: AttentionPriority, now: number): number {
  const ageMs = Math.max(0, now - Date.parse(item.createdAt));
  const age = Number.isFinite(ageMs) ? Math.min(1, ageMs / (7 * 86_400_000)) : 0;
  const urgency = clamp(item.urgency);
  const impact = clamp(item.impact);
  const confidence = clamp(item.confidence);
  const risk = clamp(item.risk ?? 0);
  const owner = item.waitingForOwner ? 1.5 : 0;
  const blocked = item.blockedByDependency ? 2 : 0;
  return 4 * urgency + 3 * impact + confidence + age + owner - blocked - risk;
}
