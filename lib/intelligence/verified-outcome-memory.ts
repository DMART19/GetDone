import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { VerifiedOutcome } from "@/lib/operations/outcomes";
import type { ContextItem } from "./context";

/** Evidence-bound operational memory for the existing context assembler. */
export function verifiedOutcomeMemory(
  outcomes: readonly VerifiedOutcome[],
  scope: { userId: string; portfolioId: string; companyId: string; environment: string },
  now: number,
  limit = 12
): readonly ContextItem[] {
  const cap = Math.max(0, Math.min(12, Math.floor(limit)));
  const selected: ContextItem[] = [];
  for (const outcome of [...outcomes].sort((a, b) =>
    String(b?.observedAt ?? "").localeCompare(String(a?.observedAt ?? "")))) {
    if (!outcome || typeof outcome !== "object" || !outcome.scope
      || typeof outcome.observedAt !== "string") continue;
    const { outcomeHash, ...payload } = outcome;
    const seenAt = Date.parse(outcome.observedAt);
    if (selected.length >= cap) break;
    if (!Number.isFinite(seenAt) || seenAt > now || now - seenAt > 30 * 86_400_000
      || outcome.scope.userId !== scope.userId || outcome.scope.portfolioId !== scope.portfolioId
      || outcome.scope.companyId !== scope.companyId || outcome.scope.environment !== scope.environment
      || outcome.verificationResult !== "verified" || sha256Hex(payload) !== outcomeHash
      || !/^[a-f0-9]{64}$/.test(outcome.verificationReceiptHash)) continue;
    selected.push(Object.freeze({
      id: "memory:" + outcome.id,
      kind: "memory" as const,
      portfolioId: scope.portfolioId,
      companyId: scope.companyId,
      source: "verified-outcome",
      provenance: "verification-receipt:" + outcome.verificationReceiptId,
      observedAt: outcome.observedAt,
      freshnessSeconds: 30 * 86_400,
      sensitivity: "internal" as const,
      content: JSON.stringify({
        objectiveId: outcome.objectiveId ?? null,
        actionType: outcome.recommendationKind,
        verifiedExecution: true,
        measuredImpact: outcome.objectiveImpact,
        ownerFeedback: outcome.ownerFeedback ?? null,
        // A verified action is not proof of a causal business improvement.
        causalityProven: false,
        verificationReceiptId: outcome.verificationReceiptId
      })
    }));
  }
  return Object.freeze(selected);
}
