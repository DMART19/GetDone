import { ControlPlaneError } from "@/lib/control-plane/errors";
import { getMvpJobRuntimeFromEnv, type MvpJobRuntime } from "@/lib/execution/mvp-job-runtime.server";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";
import {
  PostgresJobWorkerInstanceStore,
  workerErrorHash,
  type JobWorkerInstanceRecord
} from "@/lib/persistence/postgres/worker-runtime-stores";

export interface PersistentJobWorkerSnapshot {
  workerId: string;
  status: JobWorkerInstanceRecord["status"];
  startedAt: string;
  lastPollAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastErrorHash?: string;
  cycles: number;
  draining: boolean;
  stopped: boolean;
}

export interface PersistentJobWorkerConfig {
  workerId: string;
  pollIntervalMs: number;
  errorBackoffMs: number;
  recoveryLimit: number;
}

function positiveInteger(value: string | undefined, fallback: number, label: string) {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ControlPlaneError("UNAVAILABLE", `${label} must be a positive integer`);
  }
  return parsed;
}

export function readPersistentJobWorkerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): PersistentJobWorkerConfig {
  if (env.GETDONE_PROCESS_ROLE !== "job-worker") {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Persistent Job worker may start only in the dedicated job-worker process role"
    );
  }
  const workerId = env.GETDONE_JOB_WORKER_ID?.trim();
  if (!workerId) {
    throw new ControlPlaneError("UNAVAILABLE", "GETDONE_JOB_WORKER_ID is required");
  }
  if (!env.GETDONE_INTERNAL_WORKER_TOKEN?.trim()) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "GETDONE_INTERNAL_WORKER_TOKEN is required for worker control-plane authentication"
    );
  }
  return Object.freeze({
    workerId,
    pollIntervalMs: positiveInteger(
      env.GETDONE_JOB_POLL_INTERVAL_MS,
      1_000,
      "GETDONE_JOB_POLL_INTERVAL_MS"
    ),
    errorBackoffMs: positiveInteger(
      env.GETDONE_JOB_ERROR_BACKOFF_MS,
      5_000,
      "GETDONE_JOB_ERROR_BACKOFF_MS"
    ),
    recoveryLimit: positiveInteger(
      env.GETDONE_JOB_RECOVERY_LIMIT,
      50,
      "GETDONE_JOB_RECOVERY_LIMIT"
    )
  });
}

export class PersistentJobWorkerService {
  private stopped = false;
  private started = false;
  private draining = false;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;
  private cycles = 0;
  private resolveStopSignal: (() => void) | null = null;
  private readonly stopSignal: Promise<void>;
  private snapshotValue: PersistentJobWorkerSnapshot;

  constructor(
    private readonly runtime: Pick<MvpJobRuntime, "runOnce" | "recoverExpired">,
    private readonly instances: PostgresJobWorkerInstanceStore,
    private readonly config: PersistentJobWorkerConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (milliseconds: number) => Promise<void> =
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  ) {
    const startedAt = this.now().toISOString();
    this.stopSignal = new Promise((resolve) => {
      this.resolveStopSignal = resolve;
    });
    this.snapshotValue = Object.freeze({
      workerId: config.workerId,
      status: "starting",
      startedAt,
      cycles: 0,
      draining: false,
      stopped: false
    });
  }

  snapshot() {
    return this.snapshotValue;
  }

  isReady() {
    const snapshot = this.snapshotValue;
    return this.started
      && !this.stopRequested
      && !snapshot.draining
      && !snapshot.stopped
      && snapshot.status === "running";
  }

  private update(patch: Partial<PersistentJobWorkerSnapshot>) {
    this.snapshotValue = Object.freeze({
      ...this.snapshotValue,
      ...patch,
      cycles: this.cycles,
      draining: this.draining,
      stopped: this.stopped
    });
    return this.snapshotValue;
  }

  private async persist(status: JobWorkerInstanceRecord["status"]) {
    const snapshot = this.update({ status });
    await this.instances.upsert({
      workerId: snapshot.workerId,
      processRole: "job-worker",
      startedAt: snapshot.startedAt,
      lastPollAt: snapshot.lastPollAt,
      lastSuccessAt: snapshot.lastSuccessAt,
      lastErrorAt: snapshot.lastErrorAt,
      lastErrorHash: snapshot.lastErrorHash,
      status,
      updatedAt: this.now().toISOString()
    });
  }

  async runCycle() {
    const polledAt = this.now().toISOString();
    this.update({ lastPollAt: polledAt });
    const recovered = await this.runtime.recoverExpired(this.config.recoveryLimit);
    const results = await this.runtime.runOnce({
      shouldStop: () => this.stopRequested
    });
    this.cycles += 1;
    const completedAt = this.now().toISOString();
    this.update({
      status: "running",
      lastPollAt: polledAt,
      lastSuccessAt: completedAt,
      lastErrorAt: undefined,
      lastErrorHash: undefined
    });
    await this.persist("running");
    return Object.freeze({
      recovered: Object.freeze([...recovered]),
      results: Object.freeze([...results])
    });
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.draining = false;
    this.stopRequested = false;
    await this.persist("starting");
    this.loopPromise = this.loop();
  }

  requestStop() {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.draining = true;
    this.update({ draining: true });
    this.resolveStopSignal?.();
  }

  async stop() {
    if (this.stopped) return;
    this.requestStop();
    if (this.loopPromise) await this.loopPromise;
    this.stopped = true;
    this.draining = false;
    this.update({ draining: false, stopped: true });
    try {
      await this.persist("stopped");
    } catch {
      // Process shutdown must continue even if the database has already disappeared.
    }
  }

  private async wait(milliseconds: number) {
    await Promise.race([
      this.sleep(milliseconds),
      this.stopSignal
    ]);
  }

  private async loop() {
    while (!this.stopRequested) {
      try {
        await this.runCycle();
        if (!this.stopRequested) await this.wait(this.config.pollIntervalMs);
      } catch (error) {
        const at = this.now().toISOString();
        this.update({
          status: "degraded",
          lastErrorAt: at,
          lastErrorHash: workerErrorHash(error)
        });
        try {
          await this.persist("degraded");
        } catch {
          // A database outage is itself a worker degradation; retry after backoff.
        }
        if (!this.stopRequested) await this.wait(this.config.errorBackoffMs);
      }
    }
  }
}

let installed: PersistentJobWorkerService | null = null;

export function installPersistentJobWorkerFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (installed) return installed;
  const config = readPersistentJobWorkerConfig(env);
  const database = getPostgresRuntimeFromEnv(env).database;
  installed = new PersistentJobWorkerService(
    getMvpJobRuntimeFromEnv(env),
    new PostgresJobWorkerInstanceStore(database),
    config
  );
  return installed;
}

export function getInstalledPersistentJobWorker() {
  return installed;
}

export function resetPersistentJobWorkerForTests() {
  installed = null;
}
