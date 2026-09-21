import { ControlPlaneError } from "@/lib/control-plane/errors";
import { parseAuthoritativeRuntimeEnvironment } from "@/lib/control-plane/runtime-environment";
import { DurableJobEngine } from "@/lib/execution/durable-job-engine";
import { DurableJobWorker } from "@/lib/execution/job-worker-runtime";
import { assertProductionDurableJobStoreDescriptor } from "@/lib/execution/job-runtime-contracts";
import { PostgresDurableJobStore } from "@/lib/persistence/postgres/job-store";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";

let engine: DurableJobEngine | null = null;

function positiveInteger(value: string | undefined, fallback: number, label: string) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a positive integer`);
  }
  return parsed;
}

export function getDurableJobEngineFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (engine) return engine;

  const environment = parseAuthoritativeRuntimeEnvironment(env.GETDONE_RUNTIME_ENV);
  if (environment === "development") {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Production durable Job engine must not be installed in development"
    );
  }

  const runtime = getPostgresRuntimeFromEnv(env);
  const store = new PostgresDurableJobStore(runtime.database, {
    maxAttempts: positiveInteger(env.GETDONE_JOB_MAX_ATTEMPTS, 5, "GETDONE_JOB_MAX_ATTEMPTS"),
    recoveryDelayMs: positiveInteger(
      env.GETDONE_JOB_RECOVERY_DELAY_MS,
      1_000,
      "GETDONE_JOB_RECOVERY_DELAY_MS"
    )
  });
  assertProductionDurableJobStoreDescriptor(store.descriptor);

  const workerId = env.GETDONE_JOB_WORKER_ID?.trim();
  if (!workerId) {
    throw new ControlPlaneError("UNAVAILABLE", "GETDONE_JOB_WORKER_ID is required for durable execution");
  }

  const worker = new DurableJobWorker(store, {
    workerId,
    leaseSeconds: positiveInteger(env.GETDONE_JOB_LEASE_SECONDS, 60, "GETDONE_JOB_LEASE_SECONDS"),
    heartbeatSeconds: positiveInteger(
      env.GETDONE_JOB_HEARTBEAT_SECONDS,
      20,
      "GETDONE_JOB_HEARTBEAT_SECONDS"
    ),
    batchSize: positiveInteger(env.GETDONE_JOB_BATCH_SIZE, 10, "GETDONE_JOB_BATCH_SIZE"),
    retryBaseDelayMs: positiveInteger(
      env.GETDONE_JOB_RETRY_BASE_DELAY_MS,
      1_000,
      "GETDONE_JOB_RETRY_BASE_DELAY_MS"
    ),
    maxAttempts: positiveInteger(env.GETDONE_JOB_MAX_ATTEMPTS, 5, "GETDONE_JOB_MAX_ATTEMPTS")
  });

  engine = new DurableJobEngine(store, worker);
  return engine;
}

export function resetDurableJobEngineForTests() {
  engine = null;
}
