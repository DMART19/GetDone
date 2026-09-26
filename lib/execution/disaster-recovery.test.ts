import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { BusinessActionExecutionRecord } from "@/lib/execution/business-action-orchestrator";
import {
  classifyDisasterRecoveryJob,
  DISASTER_RECOVERY_CONTRACT_VERSION
} from "@/lib/execution/disaster-recovery";
import {
  createPersistedJobExecutionSpec,
  type JobExecutionSpec
} from "@/lib/execution/job-execution-router";
import { createJobQueueEnvelope } from "@/lib/execution/job-runtime-contracts";
import type { DurableJobRuntimeSnapshot } from "@/lib/persistence/postgres/job-store";

function envelope(jobId: string) {
  return createJobQueueEnvelope({
    id: `queue:${jobId}`,
    jobId,
    taskId: `task:${jobId}`,
    scope: {
      userId: "owner",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "staging"
    },
    authorizationConsumptionHash: `consumption:${jobId}`,
    idempotencyKey: `enqueue:${jobId}`,
    scheduledAt: "2026-09-25T10:00:00.000Z",
    createdAt: "2026-09-25T10:00:00.000Z"
  });
}

function runtime(jobId: string, state: DurableJobRuntimeSnapshot["state"]): DurableJobRuntimeSnapshot {
  return {
    envelope: envelope(jobId),
    version: state === "queued" ? 1 : 2,
    stateHash: "a".repeat(64),
    attempt: state === "queued" ? 0 : 1,
    state,
    scheduledAt: "2026-09-25T10:00:00.000Z"
  };
}

function businessSpec(jobId: string) {
  const request = {
    id: `request:${jobId}`,
    jobId,
    scope: envelope(jobId).scope,
    capability: "email.send",
    input: { messageRef: jobId },
    inputHash: sha256Hex({ messageRef: jobId }),
    authorizationConsumptionHash: `consumption:${jobId}`,
    idempotencyKey: `provider:${jobId}`,
    timeoutMs: 10_000,
    attempt: 1
  };
  return createPersistedJobExecutionSpec({
    kind: "business-action",
    jobId,
    authoritativeJobVersion: 1,
    authoritativeJobHash: "b".repeat(64),
    request
  });
}

function businessRecord(jobId: string, providerOperationId?: string): BusinessActionExecutionRecord {
  const persisted = businessSpec(jobId);
  if (persisted.spec.kind !== "business-action") throw new Error("business spec expected");
  const base = {
    requestId: `request:${jobId}`,
    jobId,
    requestHash: sha256Hex(persisted.spec.request),
    adapterId: "provider",
    adapterVersion: "1.0.0",
    providerOperationId,
    state: "accepted" as const,
    adapterResultHash: "c".repeat(64),
    retryable: true,
    updatedAt: "2026-09-25T10:00:01.000Z"
  };
  return { ...base, recordHash: sha256Hex(base) };
}

describe("disaster recovery classification", () => {
  it("exposes a versioned deterministic contract", () => {
    expect(DISASTER_RECOVERY_CONTRACT_VERSION).toBe("1.0.0");
  });

  it("resumes queued work because it had not crossed an execution boundary", () => {
    expect(classifyDisasterRecoveryJob({
      runtime: runtime("queued", "queued"),
      spec: businessSpec("queued")
    })).toMatchObject({
      decision: "resume",
      reasonCode: "not-yet-claimed"
    });
  });

  it("resumes a claimed business action only when provider operation identity survived", () => {
    expect(classifyDisasterRecoveryJob({
      runtime: runtime("known-provider", "claimed"),
      spec: businessSpec("known-provider"),
      businessExecution: businessRecord("known-provider", "provider-op-1")
    })).toMatchObject({
      decision: "resume",
      reasonCode: "provider-operation-known"
    });
  });

  it("requires reconciliation when a claimed provider boundary is unknown", () => {
    expect(classifyDisasterRecoveryJob({
      runtime: runtime("unknown-provider", "claimed"),
      spec: businessSpec("unknown-provider")
    })).toMatchObject({
      decision: "reconcile",
      reasonCode: "provider-boundary-unknown"
    });
  });

  it("blocks a claimed production mutation from automatic replay", () => {
    const spec = createPersistedJobExecutionSpec({
      kind: "software-deploy",
      jobId: "deploy",
      plan: {} as never,
      promotion: {} as never
    } as JobExecutionSpec);
    expect(classifyDisasterRecoveryJob({
      runtime: runtime("deploy", "claimed"),
      spec
    })).toMatchObject({
      decision: "blocked",
      reasonCode: "software-mutation-replay-unsafe"
    });
  });

  it("blocks terminal and invalid-spec Jobs", () => {
    expect(classifyDisasterRecoveryJob({
      runtime: runtime("released", "released"),
      spec: businessSpec("released")
    }).decision).toBe("blocked");

    const spec = businessSpec("tampered");
    expect(classifyDisasterRecoveryJob({
      runtime: runtime("tampered", "claimed"),
      spec: { ...spec, specHash: "0".repeat(64) }
    })).toMatchObject({
      decision: "blocked",
      reasonCode: "missing-or-invalid-execution-spec"
    });
  });
});
