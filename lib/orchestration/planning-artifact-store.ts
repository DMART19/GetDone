import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import type {
  GovernedPlanArtifact,
  OrchestrationContextSnapshot,
  OrchestrationPlanningArtifact,
  OrchestrationPlanningArtifactKind,
  PlanValidationArtifact,
  PolicyBundleArtifact
} from "@/lib/orchestration/planning-artifacts";

export interface OrchestrationPlanningArtifactStore {
  append(
    run: OrchestrationRun,
    artifact: OrchestrationPlanningArtifact
  ): Promise<{ created: boolean }>;

  latestContext(run: OrchestrationRun): Promise<OrchestrationContextSnapshot | null>;
  latestPlan(run: OrchestrationRun): Promise<GovernedPlanArtifact | null>;
  latestValidation(run: OrchestrationRun): Promise<PlanValidationArtifact | null>;
  latestPolicy(run: OrchestrationRun): Promise<PolicyBundleArtifact | null>;
  count(run: OrchestrationRun, kind: OrchestrationPlanningArtifactKind): Promise<number>;
}
