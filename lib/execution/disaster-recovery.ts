import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { BusinessActionExecutionRecord } from "@/lib/execution/business-action-orchestrator";
import type { PersistedJobExecutionSpec } from "@/lib/execution/job-execution-router";
import type { DurableJobRuntimeSnapshot } from "@/lib/persistence/postgres/job-store";

export const DISASTER_RECOVERY_CONTRACT_VERSION = "1.0.0";

export type DisasterRecoveryDecision = "resume" | "reconcile" | "blocked";

export type DisasterRecoveryReasonCode =
  | "terminal-runtime-state"
  | "missing-or-invalid-execution-spec"
  | "not-yet-claimed"
  | "provider-operation-known"
  | "provider-terminal-result-persisted"
  | "provider-boundary-unknown"
  | "provider-record-invalid"
  | "software-step-ambiguous"
  | "software-mutation-replay-unsafe";

export interface DisasterRecoveryClassification {
  decision: DisasterRecoveryDecision;
  reasonCode: DisasterRecoveryReasonCode;
  reason: string;
  runtimeHash: string;
  specHash?: string;
  providerRecordHash?: string;
}

function validSpec(record: PersistedJobExecutionSpec | null) {
  if (!record) return false;
  const { specHash, ...base } = record;
  return record.jobId === record.spec.jobId && sha256Hex(base) === specHash;
}

function validBusinessExecution(
  record: BusinessActionExecutionRecord | null | undefined,
  jobId: string,
  requestId: string
) {
  if (!record) return false;
  const { recordHash, ...base } = record;
  return record.jobId === jobId
    && record.requestId === requestId
    && sha256Hex(base) === recordHash;
}

export function classifyDisasterRecoveryJob(input: {
  runtime: DurableJobRuntimeSnapshot;
  spec: PersistedJobExecutionSpec | null;
  businessExecution?: BusinessActionExecutionRecord | null;
}): DisasterRecoveryClassification {
  const { runtime, spec, businessExecution } = input;
  const base = {
    runtimeHash: runtime.stateHash,
    specHash: spec?.specHash,
    providerRecordHash: businessExecution?.recordHash
  };

  if (["released", "dead-lettered", "cancelled"].includes(runtime.state)) {
    return {
      ...base,
      decision: "blocked",
      reasonCode: "terminal-runtime-state",
      reason: `Runtime state ${runtime.state} is terminal and must never be replayed.`
    };
  }

  if (!validSpec(spec)) {
    return {
      ...base,
      decision: "blocked",
      reasonCode: "missing-or-invalid-execution-spec",
      reason: "Execution spec is missing, tampered, or bound to a different Job."
    };
  }

  if (runtime.state === "queued" || runtime.state === "retry-wait") {
    return {
      ...base,
      decision: "resume",
      reasonCode: "not-yet-claimed",
      reason: "Job was not executing at backup time and may resume from the durable queue."
    };
  }

  if (spec!.spec.kind === "business-action") {
    const requestId = spec!.spec.request.id;
    if (businessExecution && !validBusinessExecution(businessExecution, runtime.envelope.jobId, requestId)) {
      return {
        ...base,
        decision: "blocked",
        reasonCode: "provider-record-invalid",
        reason: "Persisted provider execution record failed identity or integrity validation."
      };
    }

    if (!businessExecution) {
      return {
        ...base,
        decision: "reconcile",
        reasonCode: "provider-boundary-unknown",
        reason: "Job was claimed but no provider execution record survived; an external side effect may have crossed the boundary before persistence."
      };
    }

    if (businessExecution.providerOperationId) {
      return {
        ...base,
        decision: "resume",
        reasonCode: "provider-operation-known",
        reason: "Provider operation identity is durable; resume by status reconciliation without repeating execute()."
      };
    }

    if (
      ["completed", "rejected", "cancelled"].includes(businessExecution.state)
      || (businessExecution.state === "failed" && !businessExecution.retryable)
    ) {
      return {
        ...base,
        decision: "resume",
        reasonCode: "provider-terminal-result-persisted",
        reason: "A terminal provider result is durable and can be finalized without replaying the external mutation."
      };
    }

    return {
      ...base,
      decision: "reconcile",
      reasonCode: "provider-boundary-unknown",
      reason: "Provider state is nonterminal without a durable operation identity, so replay is ambiguous."
    };
  }

  if (spec!.spec.kind === "software-deploy" || spec!.spec.kind === "software-rollback") {
    return {
      ...base,
      decision: "blocked",
      reasonCode: "software-mutation-replay-unsafe",
      reason: "A claimed deployment or rollback may have partially mutated production and is explicitly blocked from automatic replay."
    };
  }

  return {
    ...base,
    decision: "reconcile",
    reasonCode: "software-step-ambiguous",
    reason: "A claimed software execution step requires operator reconciliation before the worker may continue."
  };
}
