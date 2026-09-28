import type { OrchestrationStageHandler } from "@/lib/orchestration/coordinator";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";

export class GovernedOrchestrationStageHandler implements OrchestrationStageHandler {
  constructor(
    private readonly planning: OrchestrationStageHandler,
    private readonly execution: OrchestrationStageHandler
  ) {}

  advance(run: OrchestrationRun) {
    switch (run.state) {
      case "received":
      case "context-building":
      case "planning":
      case "validating":
      case "policy-evaluation":
      case "replan-required":
        return this.planning.advance(run);
      case "awaiting-approval":
      case "policy-cleared":
      case "authorized":
      case "materializing":
      case "queued":
      case "executing":
      case "verifying":
        return this.execution.advance(run);
      case "succeeded":
      case "blocked":
      case "failed":
      case "cancelled":
        return this.execution.advance(run);
    }
  }
}
