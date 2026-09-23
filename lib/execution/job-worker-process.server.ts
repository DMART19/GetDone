import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  installPersistentJobWorkerFromEnv,
  type PersistentJobWorkerService
} from "@/lib/execution/persistent-job-worker.server";
import {
  assertPostgresReadyAtStartup,
  getPostgresRuntimeFromEnv
} from "@/lib/persistence/postgres/runtime.server";

export type DedicatedJobWorkerProcessState =
  | "starting"
  | "running"
  | "draining"
  | "stopped"
  | "failed";

export interface DedicatedJobWorkerProcessConfig {
  healthHost: string;
  healthPort: number;
}

function positivePort(value: string | undefined) {
  const parsed = value?.trim() ? Number(value) : 3001;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "GETDONE_JOB_WORKER_HEALTH_PORT must be an integer from 1 through 65535"
    );
  }
  return parsed;
}

export function readDedicatedJobWorkerProcessConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): DedicatedJobWorkerProcessConfig {
  const host = env.GETDONE_JOB_WORKER_HEALTH_HOST?.trim() || "0.0.0.0";
  if (host.includes("/") || host.includes("\\") || host.length > 255) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "GETDONE_JOB_WORKER_HEALTH_HOST is invalid"
    );
  }
  return Object.freeze({
    healthHost: host,
    healthPort: positivePort(env.GETDONE_JOB_WORKER_HEALTH_PORT)
  });
}

function listen(server: Server, host: string, port: number) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server | null) {
  if (!server?.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections?.();
  });
}

export class DedicatedJobWorkerProcess {
  private stateValue: DedicatedJobWorkerProcessState = "starting";
  private server: Server | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly worker: PersistentJobWorkerService,
    private readonly closeDatabase: () => Promise<void>,
    private readonly config: DedicatedJobWorkerProcessConfig
  ) {}

  state() {
    return this.stateValue;
  }

  health() {
    const worker = this.worker.snapshot();
    return Object.freeze({
      service: "getdone-job-worker",
      state: this.stateValue,
      workerId: worker.workerId,
      workerStatus: worker.status,
      cycles: worker.cycles,
      draining: worker.draining,
      stopped: worker.stopped,
      lastPollAt: worker.lastPollAt ?? null,
      lastSuccessAt: worker.lastSuccessAt ?? null,
      lastErrorAt: worker.lastErrorAt ?? null,
      lastErrorHash: worker.lastErrorHash ?? null
    });
  }

  private healthServer() {
    return createServer((request, response) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "application/json; charset=utf-8");

      if (request.method !== "GET") {
        response.statusCode = 405;
        response.setHeader("allow", "GET");
        response.end(JSON.stringify({ ok: false }));
        return;
      }

      if (request.url === "/livez") {
        const live = this.stateValue !== "failed" && this.stateValue !== "stopped";
        response.statusCode = live ? 200 : 503;
        response.end(JSON.stringify({
          ok: live,
          service: "getdone-job-worker",
          state: this.stateValue
        }));
        return;
      }

      if (request.url === "/readyz") {
        const ready = this.stateValue === "running" && this.worker.isReady();
        response.statusCode = ready ? 200 : 503;
        response.end(JSON.stringify({
          ok: ready,
          ...this.health()
        }));
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ ok: false }));
    });
  }

  async start() {
    if (this.stateValue !== "starting") {
      throw new ControlPlaneError("CONFLICT", "Dedicated Job worker process has already started");
    }

    try {
      await this.worker.start();
      this.server = this.healthServer();
      await listen(this.server, this.config.healthHost, this.config.healthPort);
      this.stateValue = "running";
    } catch (error) {
      this.stateValue = "failed";
      this.worker.requestStop();
      try { await this.worker.stop(); } catch {}
      try { await closeServer(this.server); } catch {}
      try { await this.closeDatabase(); } catch {}
      throw error;
    }
  }

  requestDrain() {
    if (this.stateValue === "stopped" || this.stateValue === "failed") return;
    this.stateValue = "draining";
    this.worker.requestStop();
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.shutdownInternal();
    return this.shutdownPromise;
  }

  private async shutdownInternal() {
    this.requestDrain();
    let shutdownError: unknown;
    try {
      await this.worker.stop();
    } catch (error) {
      shutdownError = error;
    }

    try {
      await this.closeDatabase();
    } catch (error) {
      shutdownError ??= error;
    }

    try {
      await closeServer(this.server);
    } catch (error) {
      shutdownError ??= error;
    }

    this.stateValue = shutdownError ? "failed" : "stopped";
    if (shutdownError) throw shutdownError;
  }
}

export async function createDedicatedJobWorkerProcessFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (env.GETDONE_PROCESS_ROLE !== "job-worker") {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Dedicated Job worker entrypoint requires GETDONE_PROCESS_ROLE=job-worker"
    );
  }

  if (
    env.GETDONE_RUNTIME_ENV === "production"
    || (env.NODE_ENV === "production" && !env.GETDONE_RUNTIME_ENV?.trim())
  ) {
    execFileSync(
      process.execPath,
      [path.join(process.cwd(), "scripts", "verify-production-runtime.mjs")],
      { cwd: process.cwd(), env: env as NodeJS.ProcessEnv, stdio: "inherit" }
    );
  }

  await assertPostgresReadyAtStartup(env);
  const postgres = getPostgresRuntimeFromEnv(env);
  return new DedicatedJobWorkerProcess(
    installPersistentJobWorkerFromEnv(env),
    () => postgres.database.close(),
    readDedicatedJobWorkerProcessConfig(env)
  );
}
