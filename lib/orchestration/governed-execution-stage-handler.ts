import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { OrchestrationStageHandler } from "@/lib/orchestration/coordinator";
import type { DecisionApprovalMaterializer } from "@/lib/orchestration/decision-approval-materializer";
import type { GovernedAuthorizationIssuer } from "@/lib/orchestration/governed-authorization-issuer";
import type { GovernedJobMaterializer } from "@/lib/orchestration/governed-job-materializer";
import type { GovernedTaskMaterializer } from "@/lib/orchestration/governed-task-materializer";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import type { OrchestrationPlanningArtifactStore } from "@/lib/orchestration/planning-artifact-store";
import {
  assertGovernedPlanArtifactIntegrity,
  assertPolicyBundleArtifactIntegrity
} from "@/lib/orchestration/planning-artifacts";

export class GovernedExecutionStageHandler implements OrchestrationStageHandler {
  constructor(
    private readonly planning: OrchestrationPlanningArtifactStore,
    private readonly decisions: DecisionApprovalMaterializer,
    private readonly authorization: GovernedAuthorizationIssuer,
    private readonly tasks: GovernedTaskMaterializer,
    private readonly jobs: GovernedJobMaterializer,
    private readonly now: () => Date = () => new Date()
  ) {}

  async advance(run: OrchestrationRun) {
    switch (run.state) {
      case "awaiting-approval":
        return this.awaitApproval(run);
      case "policy-cleared":
        return this.authorizeAutoPolicy(run);
      case "authorized":
        return this.materializeTasks(run);
      case "materializing":
        return this.materializeJobs(run);
      case "queued":
      case "executing":
      case "verifying":
        return Object.freeze({
          kind: "defer" as const,
          retryAt: new Date(this.now().getTime() + 300_000).toISOString(),
          reason: `provider-execution-is-outside-current-tranche:${run.state}`
        });
      case "received":
      case "context-building":
      case "planning":
      case "validating":
      case "policy-evaluation":
      case "replan-required":
        throw new ControlPlaneError(
          "CONFLICT",
          `Governed execution handler cannot advance planning state: ${run.state}`
        );
      case "succeeded":
      case "blocked":
      case "failed":
      case "cancelled":
        throw new ControlPlaneError(
          "CONFLICT",
          `Terminal orchestration state cannot be advanced: ${run.state}`
        );
    }
  }

  private async awaitApproval(run: OrchestrationRun) {
    const [plan, policy] = await Promise.all([
      this.planning.latestPlan(run),
      this.planning.latestPolicy(run)
    ]);
    if (!plan || !policy) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Approval continuation requires persisted plan and policy bundle"
      );
    }
    assertGovernedPlanArtifactIntegrity(plan);
    assertPolicyBundleArtifactIntegrity(policy);

    await this.decisions.ensure({ run, plan, policy });
    const result = await this.authorization.authorize(run);
    return this.authorizationTransition(run, result);
  }

  private async authorizeAutoPolicy(run: OrchestrationRun) {
    const result = await this.authorization.authorize(run);
    return this.authorizationTransition(run, result);
  }

  private authorizationTransition(
    run: OrchestrationRun,
    result: Awaited<ReturnType<GovernedAuthorizationIssuer["authorize"]>>
  ) {
    switch (result.kind) {
      case "authorized":
        return Object.freeze({
          kind: "transition" as const,
          state: "authorized" as const,
          wake: "immediate" as const,
          reason: "exact-hash-authorization-grants-persisted"
        });
      case "awaiting-approval":
        return Object.freeze({
          kind: "defer" as const,
          retryAt: new Date(this.now().getTime() + 15_000).toISOString(),
          reason: result.reason
        });
      case "defer":
        return Object.freeze({
          kind: "defer" as const,
          retryAt: result.retryAt,
          reason: result.reason
        });
      case "blocked":
        return Object.freeze({
          kind: "transition" as const,
          state: "blocked" as const,
          wake: "external" as const,
          reason: result.reason
        });
      case "replan-required":
        return Object.freeze({
          kind: "transition" as const,
          state: "replan-required" as const,
          wake: "external" as const,
          reason: result.reason
        });
    }
  }

  private async materializeTasks(run: OrchestrationRun) {
    await this.tasks.materialize(run);
    return Object.freeze({
      kind: "transition" as const,
      state: "materializing" as const,
      wake: "immediate" as const,
      reason: "authorized-task-dag-materialized"
    });
  }

  private async materializeJobs(run: OrchestrationRun) {
    const batch = await this.jobs.materializeAndEnqueue(run);
    return Object.freeze({
      kind: "transition" as const,
      state: "queued" as const,
      wake: "external" as const,
      reason: `job-batch-materialized:roots-enqueued=${batch.enqueued.length}`
    });
  }
}
