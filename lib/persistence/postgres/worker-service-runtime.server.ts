import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  PostgresDatabase, readPostgresConfigFromEnv,
  type PostgresConnectionConfig
} from "@/lib/persistence/postgres/client";

export type WorkerServiceRole = "getdone_worker_registry" | "getdone_job_dispatch";

export function readWorkerServiceConfigFromEnv(
  role: WorkerServiceRole,
  env: Readonly<Record<string, string | undefined>> = process.env
): PostgresConnectionConfig {
  if (
    !["staging", "production"].includes(env.GETDONE_RUNTIME_ENV ?? "")
    || !["job-worker", "orchestration-worker"].includes(env.GETDONE_PROCESS_ROLE ?? "")
    || (role === "getdone_job_dispatch" && env.GETDONE_PROCESS_ROLE !== "job-worker")
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Worker-only PostgreSQL service role cannot be used outside dedicated workers");
  }
  // Validate canonical tenant-role and verified TLS settings BEFORE overriding
  // the role for these narrow worker-only connection pools.
  return {
    ...readPostgresConfigFromEnv(env),
    runtimeRole: role,
    maxConnections: 2
  };
}

const workerPools = new Map<WorkerServiceRole, PostgresDatabase>();

export function getWorkerServiceDatabaseFromEnv(
  role: WorkerServiceRole,
  env: Readonly<Record<string, string | undefined>> = process.env
): PostgresDatabase {
  const config = readWorkerServiceConfigFromEnv(role, env);
  let pool = workerPools.get(role);
  if (!pool) {
    pool = new PostgresDatabase(config);
    workerPools.set(role, pool);
  }
  return pool;
}

export async function closeWorkerServiceDatabases() {
  const pools = [...workerPools.values()];
  workerPools.clear();
  await Promise.all(pools.map(pool => pool.close()));
}
