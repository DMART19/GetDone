import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import type {
  AuthorizationBundleExecutionArtifact,
  JobBatchExecutionArtifact,
  OrchestrationExecutionArtifact,
  OrchestrationExecutionArtifactKind,
  TaskDagExecutionArtifact,
  ValidationReceiptExecutionArtifact
} from "@/lib/orchestration/execution-artifacts";

export interface OrchestrationExecutionArtifactStore {
  append(
    run: OrchestrationRun,
    artifact: OrchestrationExecutionArtifact
  ): Promise<{ created: boolean }>;

  latestValidationReceipt(run: OrchestrationRun): Promise<ValidationReceiptExecutionArtifact | null>;
  latestAuthorizationBundle(run: OrchestrationRun): Promise<AuthorizationBundleExecutionArtifact | null>;
  latestTaskDag(run: OrchestrationRun): Promise<TaskDagExecutionArtifact | null>;
  latestJobBatch(run: OrchestrationRun): Promise<JobBatchExecutionArtifact | null>;
  count(run: OrchestrationRun, kind: OrchestrationExecutionArtifactKind): Promise<number>;
}
