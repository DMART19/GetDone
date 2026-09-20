import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type {
  AIBudgetAdmission,
  AIBudgetSnapshot,
  AIRequestEnvelope,
  ModelProfile
} from "@/lib/ai-gateway/contracts";

export function assertAIBudgetSnapshot(snapshot: AIBudgetSnapshot, request: AIRequestEnvelope, now = Date.now()) {
  const snapshotAt = Date.parse(snapshot.snapshotAt);
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (
    !Number.isFinite(snapshotAt)
    || !Number.isFinite(expiresAt)
    || snapshotAt > now
    || expiresAt <= now
    || snapshot.portfolioId !== request.scope.portfolioId
    || snapshot.companyId !== request.scope.companyId
  ) {
    throw new ControlPlaneError("FORBIDDEN", "AI budget snapshot is stale or outside request scope");
  }
  if (
    snapshot.companyRemainingCents < 0
    || snapshot.portfolioRemainingCents < 0
    || snapshot.activeConcurrentCalls < 0
    || snapshot.concurrencyLimit < 1
  ) {
    throw new ControlPlaneError("VALIDATION_FAILED", "AI budget snapshot contains invalid limits");
  }
  return snapshot;
}

export function estimateProfileRequestCostCents(profile: ModelProfile, request: AIRequestEnvelope) {
  const inputCost = request.requirements.estimatedInputTokens / 1_000_000
    * profile.inputCostPerMillionTokensCents;
  const outputCost = request.requirements.expectedOutputTokens / 1_000_000
    * profile.outputCostPerMillionTokensCents;
  return Number((inputCost + outputCost).toFixed(6));
}

export function admitAIBudget(input: {
  request: AIRequestEnvelope;
  profile: ModelProfile;
  snapshot: AIBudgetSnapshot;
  admittedAt: string;
}): AIBudgetAdmission {
  const admittedAt = Date.parse(input.admittedAt);
  if (!Number.isFinite(admittedAt)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "AI budget admission time is invalid");
  }
  assertAIBudgetSnapshot(input.snapshot, input.request, admittedAt);
  if (input.snapshot.activeConcurrentCalls >= input.snapshot.concurrencyLimit) {
    throw new ControlPlaneError("UNAVAILABLE", "AI concurrency limit reached", {
      details: { reason: "AI_CONCURRENCY_LIMIT" }
    });
  }
  const estimatedMaxCostCents = estimateProfileRequestCostCents(input.profile, input.request);
  if (
    estimatedMaxCostCents > input.request.requirements.maxCostCents
    || estimatedMaxCostCents > input.snapshot.companyRemainingCents
    || estimatedMaxCostCents > input.snapshot.portfolioRemainingCents
  ) {
    throw new ControlPlaneError("POLICY_BLOCKED", "AI budget ceiling blocks this model call", {
      details: { reason: "AI_BUDGET_BLOCKED", estimatedMaxCostCents }
    });
  }
  const base = {
    requestId: input.request.id,
    estimatedMaxCostCents,
    admitted: true as const,
    admittedAt: new Date(admittedAt).toISOString()
  };
  return Object.freeze({ ...base, budgetHash: sha256Hex(base) });
}
