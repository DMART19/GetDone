import type { BusinessActionExecutionRecord } from "@/lib/execution/business-action-orchestrator";
import type {
  DeadLetterRecord,
  JobRecoveryRecord,
  JobRetryScheduleRecord,
  JobStoreTransactionReceipt
} from "@/lib/execution/job-runtime-contracts";
import type {
  DurableJobExecutionOutcomeRecord,
  DurableJobRuntimeEventRecord
} from "@/lib/execution/job-runtime-records";
import type { VerificationEvidence } from "@/lib/verification/verification";

export type DeadLetterDisposition = "open" | "dismissed" | "cancelled" | "redriven";

export interface DeadLetterOperatorActionView {
  eventType: string;
  actorId: string;
  occurredAt: string;
  reason?: string;
  replacementJobId?: string;
  requestId?: string;
}

export interface DeadLetterSummary {
  jobId: string;
  taskId: string;
  failedAt: string;
  reason: string;
  finalAttempt: number;
  runtimeState: string;
  disposition: DeadLetterDisposition;
  updatedAt: string;
}

export interface DeadLetterExecutionSpecView {
  specHash: string;
  kind: string;
  createdAt: string;
  request?: {
    id: string;
    capability: string;
    inputHash: string;
    idempotencyKey: string;
    timeoutMs: number;
  };
}

export interface DeadLetterOperatorView {
  jobId: string;
  taskId: string;
  disposition: DeadLetterDisposition;
  lineageHash: string;
  runtime: {
    state: string;
    version: number;
    stateHash: string;
    attempt: number;
    scheduledAt: string;
    updatedAt: string;
    envelopeHash: string;
  };
  authoritativeJob: {
    state: string;
    version: number;
    attempt: number;
    maxAttempts?: number;
    authorizationGrantId?: string;
    authorizationGrantHash?: string;
    authorizationConsumptionHash?: string;
    failureReason?: string;
  };
  deadLetter: DeadLetterRecord;
  retries: readonly JobRetryScheduleRecord[];
  transactions: readonly JobStoreTransactionReceipt[];
  recoveries: readonly JobRecoveryRecord[];
  outcomes: readonly DurableJobExecutionOutcomeRecord[];
  runtimeEvents: readonly DurableJobRuntimeEventRecord[];
  executionSpec?: DeadLetterExecutionSpecView;
  providerEvidence: readonly BusinessActionExecutionRecord[];
  verificationEvidence: readonly VerificationEvidence[];
  operatorActions: readonly DeadLetterOperatorActionView[];
  retrySafety: {
    automaticRedriveSupported: boolean;
    requiresDifferentJob: true;
    requiresFreshAuthorizationLineage: true;
    reusesOldProviderOperation: false;
  };
}

export type DeadLetterOperatorAction =
  | {
      action: "dismiss";
      reason: string;
      idempotencyKey: string;
    }
  | {
      action: "cancel";
      reason: string;
      idempotencyKey: string;
    }
  | {
      action: "retry";
      reason: string;
      replacementJobId: string;
      credentialLeaseId?: string;
      idempotencyKey: string;
    };

export interface DeadLetterOperatorActionResult {
  action: DeadLetterOperatorAction["action"];
  sourceJobId: string;
  status: "completed";
  occurredAt: string;
  replacementJobId?: string;
  requestId?: string;
}
