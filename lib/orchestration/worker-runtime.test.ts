import { describe, expect, it, vi } from "vitest";
import type { OrchestrationCoordinator } from "@/lib/orchestration/coordinator";
import {
  PersistentOrchestrationWorkerService,
  readOrchestrationWorkerConfig
} from "@/lib/orchestration/worker-runtime.server";

describe("orchestration worker runtime", () => {
  it("requires a dedicated process role and stable worker identity", () => {
    expect(() => readOrchestrationWorkerConfig({})).toThrow(/dedicated orchestration-worker/i);
    expect(() => readOrchestrationWorkerConfig({
      GETDONE_PROCESS_ROLE: "orchestration-worker"
    })).toThrow(/WORKER_ID/);

    expect(readOrchestrationWorkerConfig({
      GETDONE_PROCESS_ROLE: "orchestration-worker",
      GETDONE_ORCHESTRATION_WORKER_ID: "orchestration-worker-a"
    })).toEqual({
      workerId: "orchestration-worker-a",
      pollIntervalMs: 1_000,
      leaseMilliseconds: 30_000,
      errorBackoffMs: 5_000
    });
  });

  it("validates lease and polling configuration before runtime construction", () => {
    expect(() => readOrchestrationWorkerConfig({
      GETDONE_PROCESS_ROLE: "orchestration-worker",
      GETDONE_ORCHESTRATION_WORKER_ID: "worker-a",
      GETDONE_ORCHESTRATION_LEASE_MS: "999"
    })).toThrow(/between 1000 and 300000/);

    expect(() => readOrchestrationWorkerConfig({
      GETDONE_PROCESS_ROLE: "orchestration-worker",
      GETDONE_ORCHESTRATION_WORKER_ID: "worker-a",
      GETDONE_ORCHESTRATION_POLL_INTERVAL_MS: "0"
    })).toThrow(/positive integer/);

    expect(readOrchestrationWorkerConfig({
      GETDONE_PROCESS_ROLE: "orchestration-worker",
      GETDONE_ORCHESTRATION_WORKER_ID: "worker-a",
      GETDONE_ORCHESTRATION_LEASE_MS: "45000",
      GETDONE_ORCHESTRATION_POLL_INTERVAL_MS: "250",
      GETDONE_ORCHESTRATION_ERROR_BACKOFF_MS: "1200"
    })).toMatchObject({
      leaseMilliseconds: 45_000,
      pollIntervalMs: 250,
      errorBackoffMs: 1_200
    });
  });

  it("delegates a bounded cycle to the coordinator", async () => {
    const runOnce = vi.fn(async () => ({
      runId: "run-1",
      eventId: "event-1",
      outcome: "transitioned" as const,
      previousState: "received" as const,
      state: "context-building" as const,
      wake: "immediate" as const
    }));
    const coordinator = { runOnce } as unknown as OrchestrationCoordinator;
    const service = new PersistentOrchestrationWorkerService(
      coordinator,
      {
        workerId: "worker-a",
        pollIntervalMs: 1_000,
        leaseMilliseconds: 30_000,
        errorBackoffMs: 5_000
      }
    );

    await expect(service.runCycle()).resolves.toMatchObject({
      outcome: "transitioned",
      state: "context-building"
    });
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("drains without starting new cycles after an idle poll", async () => {
    const runOnce = vi.fn(async () => null);
    let releaseSleep: (() => void) | undefined;
    const sleep = vi.fn(() => new Promise<void>((resolve) => {
      releaseSleep = resolve;
    }));
    const coordinator = { runOnce } as unknown as OrchestrationCoordinator;
    const service = new PersistentOrchestrationWorkerService(
      coordinator,
      {
        workerId: "worker-a",
        pollIntervalMs: 1_000,
        leaseMilliseconds: 30_000,
        errorBackoffMs: 5_000
      },
      sleep
    );

    await service.start();
    await Promise.resolve();
    service.requestDrain();
    releaseSleep?.();
    await service.shutdown();

    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });
});
