import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { OperationScope } from "./contracts";
import type { ObjectiveEvaluation, ObjectiveMetric } from "./objective-evaluation";
export interface VerifiedOutcome {
  id: string; scope: OperationScope; topic: string; findingId: string; recommendationId: string; recommendationKind: string;
  predictedOutcome: string; approvedPreviewHash: string; executionReceiptId: string; executionReceiptHash: string;
  verificationReceiptId: string; verificationReceiptHash: string; verificationResult: "verified" | "failed" | "uncertain";
  objectiveImpact: number | null; ownerFeedback?: "helpful" | "unhelpful"; observedAt: string; outcomeHash: string;
  objectiveId?: string; impactEvaluationIds?: readonly string[];
}
/** Measured association, not a claim that the action caused the change. No policy output. */
export function associateMeasuredImpact(outcome: VerifiedOutcome, before: ObjectiveEvaluation,
  after: ObjectiveEvaluation, metric: ObjectiveMetric): VerifiedOutcome {
  const { outcomeHash, ...base } = outcome;
  if (sha256Hex(base) !== outcomeHash || outcome.verificationResult !== "verified" || !outcome.objectiveId
    || before.objectiveId !== outcome.objectiveId || after.objectiveId !== outcome.objectiveId
    || before.metricHash !== sha256Hex(metric) || after.metricHash !== before.metricHash
    || before.current === null || after.current === null || !before.evidenceIds.length || !after.evidenceIds.length
    || ![before, after].every(e => e.portfolioId === outcome.scope.portfolioId && e.companyId === outcome.scope.companyId
      && e.environment === outcome.scope.environment)
    || !(Date.parse(before.observedAt) < Date.parse(outcome.observedAt) && Date.parse(after.observedAt) > Date.parse(outcome.observedAt))) return outcome;
  const changed = { ...base, objectiveImpact: (after.current - before.current) * (metric.operator === "lte" ? -1 : 1),
    impactEvaluationIds: [before.id, after.id] };
  return { ...changed, outcomeHash: sha256Hex(changed) };
}
/** This record is constructed by trusted receipt persistence, not accepted from conversation/model output. */
export function verifiedRecommendationScore(base: number, kind: string, topic: string, scope: OperationScope,
  outcomes: readonly VerifiedOutcome[], now = Date.now()): number {
  const seen = new Set<string>();
  const eligible = outcomes.filter(o => {
    const { outcomeHash, ...payload } = o;
    const key = `${o.executionReceiptId}:${o.verificationReceiptId}`;
    if (seen.has(key) || sha256Hex(payload) !== outcomeHash || o.scope.portfolioId !== scope.portfolioId
      || o.scope.companyId !== scope.companyId || o.scope.environment !== scope.environment || o.scope.userId !== scope.userId
      || o.topic !== topic || o.recommendationKind !== kind || o.verificationResult !== "verified"
      || Date.parse(o.observedAt) > now || !Number.isFinite(Date.parse(o.observedAt))
      || !Number.isFinite(o.objectiveImpact) || !/^[a-f0-9]{64}$/.test(o.approvedPreviewHash)
      || !/^[a-f0-9]{64}$/.test(o.executionReceiptHash) || !/^[a-f0-9]{64}$/.test(o.verificationReceiptHash)) return false;
    seen.add(key); return true;
  });
  // Only ranking changes. No policy, allowlist, scope, or approval object is returned or mutated.
  const positive = eligible.filter(o => o.objectiveImpact !== null && o.objectiveImpact > 0 && o.ownerFeedback !== "unhelpful").length;
  return base + Math.min(0.2, positive * 0.025);
}
