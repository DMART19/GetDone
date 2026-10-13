import type { DedicatedOrchestrationWorkerProcess } from "@/lib/orchestration/worker-process.server";
import { redactTelemetryText } from "@/lib/observability/telemetry";
import { runObjectiveEvaluationPass } from "@/lib/operations/scheduler.server";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";
import { readServerRuntimeEnvironment } from "@/lib/control-plane/runtime-environment.server";
import {
  createAuthoritativeOrchestrationWorkerProcessFromEnv
} from "@/lib/orchestration/orchestration-worker-runtime.server";

let workerProcess: DedicatedOrchestrationWorkerProcess | null = null;
let terminating = false;
let objectiveTimer: ReturnType<typeof setInterval> | undefined;
let objectivePass: Promise<unknown> | undefined;

function safeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: redactTelemetryText(error.message) };
  }
  return { name: "UnknownError", message: redactTelemetryText(String(error)) };
}

async function terminate(exitCode: number, reason: string, error?: unknown) {
  if (terminating) return;
  terminating = true;
  if (objectiveTimer) clearInterval(objectiveTimer);
  if (objectivePass) await objectivePass.catch(() => {});

  if (error) {
    console.error("GetDone orchestration worker terminating", {
      reason,
      ...safeError(error)
    });
  } else {
    console.log("GetDone orchestration worker draining", { reason });
  }

  try {
    workerProcess?.requestDrain();
    if (workerProcess) await workerProcess.shutdown();
  } catch (shutdownError) {
    console.error(
      "GetDone orchestration worker shutdown failed",
      safeError(shutdownError)
    );
    exitCode = 1;
  }

  process.exit(exitCode);
}

process.once("SIGTERM", () => {
  void terminate(0, "SIGTERM");
});
process.once("SIGINT", () => {
  void terminate(0, "SIGINT");
});
process.once("uncaughtException", (error) => {
  void terminate(1, "uncaughtException", error);
});
process.once("unhandledRejection", (error) => {
  void terminate(1, "unhandledRejection", error);
});

async function main() {
  try {
    workerProcess = await createAuthoritativeOrchestrationWorkerProcessFromEnv();
    await workerProcess.start();
    const evaluatorUserId = process.env.GETDONE_OBJECTIVE_EVALUATOR_USER_ID;
    if (evaluatorUserId) {
      const interval = Number(process.env.GETDONE_OBJECTIVE_EVALUATION_INTERVAL_MS ?? 300_000);
      if (!Number.isSafeInteger(interval) || interval < 60_000) throw new Error("Objective evaluation interval must be at least one minute");
      objectiveTimer = setInterval(() => {
        if (objectivePass || terminating) return;
        const slot = new Date(Math.floor(Date.now() / interval) * interval).toISOString();
        objectivePass = runObjectiveEvaluationPass(getPostgresRuntimeFromEnv().database, evaluatorUserId, readServerRuntimeEnvironment(), slot)
          .catch(() => console.error("Read-only objective evaluation failed; no consequential actions executed"))
          .finally(() => { objectivePass = undefined; });
      }, interval);
    }
    console.log("GetDone orchestration worker started", workerProcess.health());
  } catch (error) {
    await terminate(1, "startup-failure", error);
  }
}

void main();
