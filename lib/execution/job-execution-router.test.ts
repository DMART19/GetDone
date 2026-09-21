import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { createJobQueueEnvelope } from "@/lib/execution/job-runtime-contracts";
import {
  RoutedJobExecutionHandler,
  createPersistedJobExecutionSpec,
  type JobExecutionSpecStore,
  type PersistedJobExecutionSpec
} from "@/lib/execution/job-execution-router";
import type { DurableJobExecutionContext } from "@/lib/execution/job-worker-runtime";

class MemorySpecStore implements JobExecutionSpecStore {
  value: PersistedJobExecutionSpec | null = null;
  async get(jobId: string) { return this.value?.jobId === jobId ? this.value : null; }
  async put(record: PersistedJobExecutionSpec) { this.value = record; }
}

const envelope = createJobQueueEnvelope({
  id: "queue-1",
  jobId: "job-1",
  taskId: "task-1",
  scope: {
    userId: "owner",
    portfolioId: "portfolio",
    companyId: "company",
    environment: "staging"
  },
  authorizationConsumptionHash: "auth",
  idempotencyKey: "queue-1",
  scheduledAt: "2026-09-21T04:00:00Z",
  createdAt: "2026-09-21T04:00:00Z"
});

const context = {
  envelope,
  lease: {} as never,
  heartbeat: async () => undefined,
  runtimeVersion: () => 1,
  runtimeHash: () => "hash"
} satisfies DurableJobExecutionContext;

describe("RoutedJobExecutionHandler", () => {
  it("dead-letters a Job with no durable execution spec", async () => {
    const handler = new RoutedJobExecutionHandler(
      new MemorySpecStore(),
      {} as never,
      {} as never
    );
    await expect(handler.execute(context)).resolves.toEqual({
      kind: "dead-letter",
      reason: "Job execution spec is missing"
    });
  });

  it("routes completed business actions to durable Job success", async () => {
    const specs = new MemorySpecStore();
    const payload = { message: "hello" };
    specs.value = createPersistedJobExecutionSpec({
      kind: "business-action",
      jobId: "job-1",
      request: {
        id: "action-1",
        jobId: "job-1",
        scope: envelope.scope,
        capability: "email.send",
        input: payload,
        inputHash: sha256Hex(payload),
        authorizationConsumptionHash: "auth",
        idempotencyKey: "action-1",
        timeoutMs: 1000,
        attempt: 1
      }
    }, "2026-09-21T04:00:00Z");

    const business = {
      execute: async () => ({
        record: { state: "completed", retryable: false }
      })
    };
    const handler = new RoutedJobExecutionHandler(
      specs,
      business as never,
      {} as never
    );
    expect(await handler.execute(context)).toEqual({ kind: "succeeded" });
  });

  it("rejects tampered persisted execution specs", async () => {
    const specs = new MemorySpecStore();
    const valid = createPersistedJobExecutionSpec({
      kind: "software-prepare",
      jobId: "job-1",
      plan: {} as never
    }, "2026-09-21T04:00:00Z");
    specs.value = { ...valid, specHash: "tampered" };
    const handler = new RoutedJobExecutionHandler(specs, {} as never, {} as never);
    await expect(handler.execute(context)).rejects.toThrow(/tampered/i);
  });
});
