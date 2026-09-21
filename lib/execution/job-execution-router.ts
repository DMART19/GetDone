import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import type { BusinessActionExecutionOrchestrator } from "@/lib/execution/business-action-orchestrator";
import type {
  DurableJobExecutionContext,
  DurableJobExecutionHandler,
  JobExecutionOutcome
} from "@/lib/execution/job-worker-runtime";
import type {
  ProductionPromotionReceipt,
  SoftwarePostDeploymentVerificationEvidence,
  SoftwareWorkerPlan
} from "@/lib/execution/software-worker";
import type { SoftwareWorkerRuntime } from "@/lib/execution/software-worker-runtime";

export const JOB_EXECUTION_ROUTER_VERSION = "1.0.0";

export type JobExecutionSpec =
  | {
      kind: "business-action";
      jobId: string;
      request: AuthorizedBusinessActionRequest;
    }
  | {
      kind: "software-prepare";
      jobId: string;
      plan: SoftwareWorkerPlan;
    }
  | {
      kind: "software-deploy";
      jobId: string;
      plan: SoftwareWorkerPlan;
      promotion: ProductionPromotionReceipt;
    }
  | {
      kind: "software-verify";
      jobId: string;
      plan: SoftwareWorkerPlan;
      verification: SoftwarePostDeploymentVerificationEvidence;
    }
  | {
      kind: "software-rollback";
      jobId: string;
      plan: SoftwareWorkerPlan;
    };

export interface PersistedJobExecutionSpec {
  jobId: string;
  spec: JobExecutionSpec;
  specHash: string;
  createdAt: string;
}

export interface JobExecutionSpecStore {
  get(jobId: string): Promise<PersistedJobExecutionSpec | null>;
  put(record: PersistedJobExecutionSpec): Promise<void>;
}

export function createPersistedJobExecutionSpec(
  spec: JobExecutionSpec,
  createdAt = new Date().toISOString()
): PersistedJobExecutionSpec {
  if (spec.jobId.trim().length === 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Job execution spec requires jobId");
  }
  const base = { jobId: spec.jobId, spec, createdAt };
  return Object.freeze({ ...base, specHash: sha256Hex(base) });
}

function assertPersistedSpec(record: PersistedJobExecutionSpec, jobId: string) {
  const { specHash, ...base } = record;
  if (
    sha256Hex(base) !== specHash
    || record.jobId !== jobId
    || record.spec.jobId !== jobId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Persisted Job execution spec is tampered or bound to a different Job"
    );
  }
  return record;
}

export class RoutedJobExecutionHandler implements DurableJobExecutionHandler {
  constructor(
    private readonly specs: JobExecutionSpecStore,
    private readonly business: BusinessActionExecutionOrchestrator,
    private readonly software: SoftwareWorkerRuntime
  ) {}

  async execute(context: DurableJobExecutionContext): Promise<JobExecutionOutcome> {
    const persisted = await this.specs.get(context.envelope.jobId);
    if (!persisted) {
      return { kind: "dead-letter", reason: "Job execution spec is missing" };
    }
    const { spec } = assertPersistedSpec(persisted, context.envelope.jobId);

    switch (spec.kind) {
      case "business-action": {
        if (spec.request.jobId !== context.envelope.jobId) {
          return { kind: "dead-letter", reason: "Business action Job lineage mismatch" };
        }
        const result = await this.business.execute(spec.request);
        switch (result.record.state) {
          case "completed":
            return { kind: "succeeded" };
          case "cancelled":
            return { kind: "cancelled", reason: "Provider operation was cancelled" };
          case "rejected":
            return { kind: "dead-letter", reason: "Provider rejected the authorized action" };
          case "failed":
            return result.record.retryable
              ? { kind: "retry", reason: "Provider reported retryable action failure" }
              : { kind: "dead-letter", reason: "Provider reported terminal action failure" };
          default:
            return {
              kind: "retry",
              reason: "Provider operation is still pending",
              delayMs: 2_000
            };
        }
      }
      case "software-prepare": {
        const runtime = await this.software.prepare(spec.plan);
        return runtime.pipeline.state === "awaiting-production-approval"
          ? { kind: "succeeded" }
          : { kind: "retry", reason: `Software preparation paused at ${runtime.pipeline.state}` };
      }
      case "software-deploy": {
        const result = await this.software.deployProduction(spec.plan, spec.promotion);
        return result.runtime.pipeline.state === "post-deploy-verifying"
          ? { kind: "succeeded" }
          : { kind: "retry", reason: "Software deployment did not reach verification handoff" };
      }
      case "software-verify": {
        const runtime = await this.software.completeProductionVerification(
          spec.plan,
          spec.verification
        );
        return runtime.pipeline.state === "succeeded"
          ? { kind: "succeeded" }
          : { kind: "dead-letter", reason: "Software verification failed to establish success" };
      }
      case "software-rollback": {
        const runtime = await this.software.rollback(spec.plan);
        return runtime.pipeline.state === "rolled-back"
          ? { kind: "succeeded" }
          : { kind: "dead-letter", reason: "Software rollback did not reach terminal state" };
      }
    }
  }
}
