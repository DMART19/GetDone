import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { validPlan } from "@/lib/planning/test-fixture";
import { autoGrantFor, fixtureNow, receiptFor } from "@/lib/planning/test-security-fixture";
import { TaskGenerator } from "@/lib/planning/task-generator";
import { DagCompiler } from "@/lib/planning/dag-compiler";
import { createObjectiveOrchestrationRun } from "./objective-flow";
import type { DurableTaskDagArtifact } from "./post-authorization-flow";
import type { PersistedPlanProposal } from "./planning-flow";

export async function executionFixture() {
  const proposal = validPlan();
  const receipt = receiptFor(proposal);
  const grant = autoGrantFor(proposal, proposal.steps[0].id, receipt);
  const run = createObjectiveOrchestrationRun({
    objective: { id: "objective-1", scopeId: "company-a", metric: "release-readiness", direction: "increase", target: 1, priority: 1, status: "active" },
    scope: grant.scope, createdAt: fixtureNow.toISOString()
  });
  const result = await new TaskGenerator({ claim: async (task, consumption) => ({ created: true, task, consumption }) }, () => `task:${run.id}:step-1`, () => fixtureNow).generate({
    plan: proposal, validationReceipt: receipt, authorizationGrants: { [proposal.steps[0].id]: grant }, objectiveStatus: "active"
  });
  if (result.status !== "created") throw new Error(result.reasons.join(","));
  const planBase = { id: "plan-artifact-1", runId: run.id, planningRunVersion: 2, correlationId: run.correlationId, portfolioId: run.scope.portfolioId, companyId: run.scope.companyId,
    plannerInputId: "input-1", plannerInputHash: sha256Hex("input"), plannerRequestId: "request-1", proposal, planHash: sha256Hex(proposal), createdAt: fixtureNow.toISOString() };
  const plan: PersistedPlanProposal = { ...planBase, artifactHash: sha256Hex(planBase) };
  const base = { id: `task-dag:${run.id}`, runId: run.id, authorizedRunVersion: 8, correlationId: run.correlationId, portfolioId: run.scope.portfolioId, companyId: run.scope.companyId,
    planArtifactId: plan.id, planHash: plan.planHash, validationReceiptId: receipt.id, validationReceiptHash: receipt.receiptHash,
    tasks: result.tasks, dag: new DagCompiler().compile(result.tasks), createdAt: fixtureNow.toISOString() };
  const taskDag: DurableTaskDagArtifact = { ...base, artifactHash: sha256Hex(base) };
  return { run, plan, taskDag, grant, now: () => fixtureNow };
}
