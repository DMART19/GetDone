import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { AuthorizationGrant } from "@/lib/authorization/grants";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { JobQueueEnvelope, JobStoreTransactionReceipt } from "@/lib/execution/job-runtime-contracts";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import type { ExecutableDag } from "@/lib/planning/dag-compiler";
import type { GeneratedTask } from "@/lib/planning/task-generator";
import type { PlanValidationReceipt } from "@/lib/planning/validation-receipt";

export const ORCHESTRATION_EXECUTION_ARTIFACT_CONTRACT_VERSION = "1.0.0";

export type OrchestrationExecutionArtifactKind =
  | "validation-receipt"
  | "authorization-bundle"
  | "task-dag"
  | "job-batch";

export interface ValidationReceiptExecutionArtifact {
  id: string;
  runId: string;
  correlationId: string;
  planHash: string;
  receipt: PlanValidationReceipt;
  createdAt: string;
  artifactHash: string;
}

export interface AuthorizationBundleExecutionArtifact {
  id: string;
  runId: string;
  correlationId: string;
  planHash: string;
  validationReceiptId: string;
  validationReceiptHash: string;
  grants: readonly AuthorizationGrant[];
  createdAt: string;
  artifactHash: string;
}

export interface TaskDagExecutionArtifact {
  id: string;
  runId: string;
  correlationId: string;
  planHash: string;
  authorizationBundleId: string;
  tasks: readonly GeneratedTask[];
  dag: ExecutableDag;
  createdAt: string;
  artifactHash: string;
}

export interface EnqueuedJobEvidence {
  jobId: string;
  envelope: JobQueueEnvelope;
  transaction: JobStoreTransactionReceipt;
}

export interface JobBatchExecutionArtifact {
  id: string;
  runId: string;
  correlationId: string;
  planHash: string;
  taskDagArtifactId: string;
  jobs: readonly JobRecord[];
  enqueued: readonly EnqueuedJobEvidence[];
  providerExecutionSpecsCreated: false;
  createdAt: string;
  artifactHash: string;
}

export type OrchestrationExecutionArtifact =
  | Readonly<{ kind: "validation-receipt"; value: ValidationReceiptExecutionArtifact }>
  | Readonly<{ kind: "authorization-bundle"; value: AuthorizationBundleExecutionArtifact }>
  | Readonly<{ kind: "task-dag"; value: TaskDagExecutionArtifact }>
  | Readonly<{ kind: "job-batch"; value: JobBatchExecutionArtifact }>;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function requireTimestamp(value: string, label: string) {
  if (!Number.isFinite(Date.parse(value))) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
}

export function executionArtifactId(input: {
  kind: OrchestrationExecutionArtifactKind;
  run: Pick<OrchestrationRun, "id" | "version">;
  predecessorHash: string;
}) {
  return `orchestration-execution:${input.kind}:${sha256Hex({
    runId: input.run.id,
    runVersion: input.run.version,
    predecessorHash: input.predecessorHash
  })}`;
}

function withArtifactHash<T extends { createdAt: string }>(value: T) {
  requireTimestamp(value.createdAt, "execution artifact createdAt");
  return deepFreeze({
    ...value,
    artifactHash: sha256Hex(value)
  });
}

export function createValidationReceiptExecutionArtifact(
  input: Omit<ValidationReceiptExecutionArtifact, "artifactHash">
) {
  return withArtifactHash(input);
}

export function createAuthorizationBundleExecutionArtifact(
  input: Omit<AuthorizationBundleExecutionArtifact, "artifactHash">
) {
  return withArtifactHash({
    ...input,
    grants: [...input.grants]
  });
}

export function createTaskDagExecutionArtifact(
  input: Omit<TaskDagExecutionArtifact, "artifactHash">
) {
  return withArtifactHash({
    ...input,
    tasks: [...input.tasks]
  });
}

export function createJobBatchExecutionArtifact(
  input: Omit<JobBatchExecutionArtifact, "artifactHash">
) {
  if (input.providerExecutionSpecsCreated !== false) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "This orchestration tranche may not create provider execution specs"
    );
  }
  return withArtifactHash({
    ...input,
    jobs: [...input.jobs],
    enqueued: [...input.enqueued]
  });
}

export function assertExecutionArtifactIntegrity(
  artifact: OrchestrationExecutionArtifact
) {
  const { artifactHash, ...base } = artifact.value;
  if (
    sha256Hex(base) !== artifactHash
    || artifact.value.runId.trim().length === 0
    || artifact.value.correlationId.trim().length === 0
    || artifact.value.planHash.trim().length === 0
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Orchestration execution artifact integrity failed"
    );
  }
  if (
    artifact.kind === "job-batch"
    && artifact.value.providerExecutionSpecsCreated !== false
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Job materialization artifact crossed the provider-execution boundary"
    );
  }
  return artifact;
}
