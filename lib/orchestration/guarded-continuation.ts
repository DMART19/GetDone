import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { ObjectiveRecord } from "@/lib/domain/objective-inbox";
import { createOrchestrationRun, createOrchestrationSourceRef, assertOrchestrationRunIntegrity, type OrchestrationRunRecord } from "@/lib/orchestration/contracts";
import type { OrchestrationRunStore } from "@/lib/orchestration/contracts";
import { adviseObjectiveContinuation } from "@/lib/operations/objective-continuation";
import type { VerifiedOutcome } from "@/lib/operations/outcomes";

export const MAX_OBJECTIVE_CONTINUATION_CYCLES = 3;

export interface VerifiedContinuationInput {
  objective: ObjectiveRecord;
  outcome: VerifiedOutcome;
  predecessor: OrchestrationRunRecord;
  runCount: number;
  now: string;
}

/** This is admission to *planning*, never an execution grant. */
export function createGuardedContinuation(input: VerifiedContinuationInput): OrchestrationRunRecord | null {
  const { objective, outcome, predecessor } = input;
  const { outcomeHash, ...outcomeBase } = outcome;
  assertOrchestrationRunIntegrity(predecessor);
  if (!Number.isInteger(input.runCount) || input.runCount < 1 || input.runCount >= MAX_OBJECTIVE_CONTINUATION_CYCLES) return null;
  if (sha256Hex(outcomeBase) !== outcomeHash || outcome.verificationResult !== "verified"
    || !/^[a-f0-9]{64}$/.test(outcome.verificationReceiptHash)
    || !Number.isFinite(Date.parse(outcome.observedAt)) || Date.parse(outcome.observedAt) > Date.parse(input.now)
    || outcome.objectiveId !== objective.id
    || predecessor.source.type !== "objective" || predecessor.source.id !== objective.id
    || predecessor.state !== "completed" || predecessor.checkpoints.verifiedOutcomes.length === 0
    || objective.portfolioId !== predecessor.scope.portfolioId
    || objective.companyId !== predecessor.scope.companyId
    || objective.environment !== predecessor.scope.environment
    || objective.createdByUserId !== predecessor.scope.userId
    || outcome.scope.userId !== predecessor.scope.userId
    || outcome.scope.portfolioId !== predecessor.scope.portfolioId
    || outcome.scope.companyId !== predecessor.scope.companyId
    || outcome.scope.environment !== predecessor.scope.environment
  ) throw new ControlPlaneError("FORBIDDEN", "Continuation requires verified, scoped and completed predecessor lineage");

  // A newer completed run must not be restarted using an older outcome.
  if (Date.parse(predecessor.createdAt) >= Date.parse(outcome.observedAt)) return null;
  const decision = adviseObjectiveContinuation(objective, {});
  // Unknown dependencies must fail closed. No re-entry on ambiguous or blocked status.
  if (decision.decision !== "continue_existing_plan") return null;

  // Each outcome has one deterministic identity across retries and worker restarts.
  const key = sha256Hex({ objectiveId: objective.id, outcomeHash, verifiedBy: predecessor.id });
  return createOrchestrationRun({
    id: `orchestration:objective-continuation:${key}`,
    correlationId: `objective-continuation:${key}`,
    source: createOrchestrationSourceRef("objective", objective.id, objective),
    scope: predecessor.scope,
    createdAt: input.now,
    updatedAt: input.now
  });
}

export async function persistGuardedContinuation(input: VerifiedContinuationInput & {
  runs: Pick<OrchestrationRunStore, "get" | "create">;
}): Promise<"created" | "replayed" | "ineligible"> {
  const candidate = createGuardedContinuation(input);
  if (!candidate) return "ineligible";
  const prior = await input.runs.get(candidate.id);
  if (prior) {
    assertOrchestrationRunIntegrity(prior);
    if (prior.source.sourceHash !== candidate.source.sourceHash || prior.scope.userId !== candidate.scope.userId
      || prior.scope.companyId !== candidate.scope.companyId || prior.scope.portfolioId !== candidate.scope.portfolioId
      || prior.scope.environment !== candidate.scope.environment) throw new ControlPlaneError("IDEMPOTENCY_CONFLICT", "Continuation lineage changed");
    return "replayed";
  }
  const created = await input.runs.create(candidate, `continuation:${candidate.id}`);
  return created.status === "created" ? "created" : "replayed";
}
