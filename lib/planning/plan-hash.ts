import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { PlanProposal, PlanStep } from "@/lib/planning/plan-schema";

export const PLAN_HASH_VERSION = "1";

export function hashPlanStep(step: PlanStep) {
  return sha256Hex({
    hashVersion: PLAN_HASH_VERSION,
    step
  });
}

export function hashPlan(plan: PlanProposal) {
  return sha256Hex({
    hashVersion: PLAN_HASH_VERSION,
    plan
  });
}

export function planStepHashes(plan: PlanProposal) {
  return Object.freeze(Object.fromEntries(
    plan.steps.map((step) => [step.id, hashPlanStep(step)])
  )) as Readonly<Record<string, string>>;
}
