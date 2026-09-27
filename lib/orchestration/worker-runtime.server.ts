import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  OrchestrationCoordinator,
  type OrchestrationStageHandler
} from "@/lib/orchestration/coordinator";
import { PostgresOrchestrationRuntimeStore } from "@/lib/persistence/postgres/orchestration-store";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";

export interface OrchestrationWorkerConfig {
  workerId: string;
  pollIntervalMs: number;
  leaseMilliseconds: number;
  errorBackoffMs: number;
}

function positiveInteger(value: string | undefined, fallback: number, label: string) {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a positive integer`);
  }
  return parsed;
}

export function readOrchestrationWorkerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): OrchestrationWorkerConfig {
  if (env.GETDONE_PROCESS_ROLE !== "orchestration-worker") {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Orchestration worker may start only in the dedicated orchestration-worker process role"
    );
  }

  const workerId = env.GETDONE_ORCHESTRATION_WORKER_ID?.trim();
  if (!workerId) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "GETDONE_ORCHESTRATION_WORKER_ID is required"
    );
  }

  const leaseMilliseconds = positiveInteger(
    env.GETDONE_ORCHESTRATION_LEASE_MS,
    30_000,
    "GETDONE_ORCHESTRATION_LEASE_MS"
  );
  if (leaseMilliseconds < 1_000 || leaseMilliseconds > 300_000) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "GETDONE_ORCHESTRATION_LEASE_MS must be between 1000 and 300000"
    );
  }

  return Object.freeze({
    workerId,
    pollIntervalMs: positiveInteger(
      env.GETDONE_ORCHESTRATION_POLL_INTERVAL_MS,
      1_000,
      "GETDONE_ORCHESTRATION_POLL_INTERVAL_MS"
    ),
    leaseMilliseconds,
    errorBackoffMs: positiveInteger(
      env.GETDONE_ORCHESTRATION_ERROR_BACKOFF_MS,
      5_000,
      "GETDONE_ORCHESTRATION_ERROR_BACKOFF_MS"
    )
  });
}

export class PersistentOrchestrationWorkerService {
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;
  private resolveStopSignal: (() => void) | null = null;
  private readonly stopSignal: Promise<void>;

  constructor(
    private readonly coordinator: OrchestrationCoordinator,
    private readonly config: OrchestrationWorkerConfig,
    private readonly sleep: (milliseconds: number) => Promise<void> =
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  ) {
    this.stopSignal = new Promise((resolve) => {
      this.resolveStopSignal = resolve;
    });
  }

  async runCycle() {
    return this.coordinator.runOnce();
  }

  async start() {
    if (this.loopPromise) return;
    this.stopRequested = false;
    this.loopPromise = this.loop();
  }

  requestDrain() {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.resolveStopSignal?.();
  }

  async shutdown() {
    this.requestDrain();
    if (this.loopPromise) await this.loopPromise;
    this.loopPromise = null;
  }

  private wait(milliseconds: number) {
    return Promise.race([
      this.sleep(milliseconds),
      this.stopSignal
    ]);
  }

  private async loop() {
    while (!this.stopRequested) {
      try {
        const result = await this.runCycle();
        if (!this.stopRequested && result === null) {
          await this.wait(this.config.pollIntervalMs);
        }
      } catch {
        if (!this.stopRequested) {
          await this.wait(this.config.errorBackoffMs);
        }
      }
    }
  }
}

export function createOrchestrationWorkerServiceFromEnv(
  handler: OrchestrationStageHandler,
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const config = readOrchestrationWorkerConfig(env);
  const database = getPostgresRuntimeFromEnv(env).database;
  const store = new PostgresOrchestrationRuntimeStore(database);
  const coordinator = new OrchestrationCoordinator(
    store,
    handler,
    {
      workerId: config.workerId,
      leaseMilliseconds: config.leaseMilliseconds,
      errorBackoffMilliseconds: config.errorBackoffMs
    }
  );
  return new PersistentOrchestrationWorkerService(coordinator, config);
}
