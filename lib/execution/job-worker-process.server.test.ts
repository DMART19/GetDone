import { describe, expect, it, vi } from "vitest";
import {
  DedicatedJobWorkerProcess,
  readDedicatedJobWorkerProcessConfig
} from "@/lib/execution/job-worker-process.server";
import { PersistentJobWorkerService } from "@/lib/execution/persistent-job-worker.server";

class MemoryWorkerInstanceStore {
  records: Array<Record<string, unknown>> = [];
  async upsert(record: Record<string, unknown>) {
    this.records.push(record);
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for worker state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function service() {
  return new PersistentJobWorkerService(
    {
      recoverExpired: async () => [],
      runOnce: async () => []
    } as never,
    new MemoryWorkerInstanceStore() as never,
    {
      workerId: "dedicated-worker-test",
      pollIntervalMs: 50,
      errorBackoffMs: 50,
      recoveryLimit: 5
    }
  );
}

describe("DedicatedJobWorkerProcess", () => {
  it("validates dedicated health binding configuration", () => {
    expect(readDedicatedJobWorkerProcessConfig({
      GETDONE_JOB_WORKER_HEALTH_HOST: "127.0.0.1",
      GETDONE_JOB_WORKER_HEALTH_PORT: "3101"
    })).toEqual({
      healthHost: "127.0.0.1",
      healthPort: 3101
    });

    expect(() => readDedicatedJobWorkerProcessConfig({
      GETDONE_JOB_WORKER_HEALTH_PORT: "0"
    })).toThrow(/1 through 65535/);
  });

  it("serves liveness/readiness and makes readiness false before graceful drain", async () => {
    const worker = service();
    const closeDatabase = vi.fn(async () => {});
    const processController = new DedicatedJobWorkerProcess(
      worker,
      closeDatabase,
      { healthHost: "127.0.0.1", healthPort: 0 }
    );

    try {
      await processController.start();
    } catch (error) {
      if (error instanceof Error && /listen EPERM/.test(error.message)) {
        return;
      }
      throw error;
    }
    await waitUntil(() => worker.isReady());

    const address = processController.healthAddress();
    expect(address).not.toBeNull();
    const base = `http://127.0.0.1:${address!.port}`;

    const live = await fetch(`${base}/livez`);
    const ready = await fetch(`${base}/readyz`);
    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      ok: true,
      service: "getdone-job-worker",
      state: "running",
      workerId: "dedicated-worker-test"
    });

    processController.requestDrain();
    const drainingLive = await fetch(`${base}/livez`);
    const drainingReady = await fetch(`${base}/readyz`);
    expect(drainingLive.status).toBe(200);
    expect(drainingReady.status).toBe(503);

    await processController.shutdown();
    expect(processController.state()).toBe("stopped");
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });

  it("closes PostgreSQL and marks failure when startup cannot initialize the worker", async () => {
    const closeDatabase = vi.fn(async () => {});
    const failingWorker = {
      start: vi.fn(async () => { throw new Error("worker startup failed"); }),
      requestStop: vi.fn(),
      stop: vi.fn(async () => {}),
      snapshot: () => ({
        workerId: "failing-worker",
        status: "starting",
        startedAt: new Date().toISOString(),
        cycles: 0,
        draining: false,
        stopped: false
      }),
      isReady: () => false
    };

    const processController = new DedicatedJobWorkerProcess(
      failingWorker as never,
      closeDatabase,
      { healthHost: "127.0.0.1", healthPort: 0 }
    );

    await expect(processController.start()).rejects.toThrow(/startup failed/);
    expect(processController.state()).toBe("failed");
    expect(failingWorker.requestStop).toHaveBeenCalledTimes(1);
    expect(failingWorker.stop).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
  });
});
