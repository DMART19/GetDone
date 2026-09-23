import { Pool } from "pg";
import type { JobRecord } from "@/lib/domain/services/job-service";
import {
  createBusinessActionAdapterResult,
  createBusinessActionStatus,
  type AuthorizedBusinessActionRequest,
  type BusinessActionAdapter
} from "@/lib/execution/adapters/business-action";
import { StaticBusinessActionAdapterRegistry } from "@/lib/execution/adapters/business-action-registry";
import { BusinessActionExecutionOrchestrator } from "@/lib/execution/business-action-orchestrator";
import { DurableJobWorker } from "@/lib/execution/job-worker-runtime";
import { RoutedJobExecutionHandler } from "@/lib/execution/job-execution-router";
import { PersistentJobWorkerService } from "@/lib/execution/persistent-job-worker.server";
import { PostgresBusinessActionExecutionStore } from "@/lib/persistence/postgres/execution-stores";
import { PostgresJobExecutionSpecStore } from "@/lib/persistence/postgres/job-execution-spec-store";
import {
  PostgresDurableJobStore,
  type DurableJobWorkStore
} from "@/lib/persistence/postgres/job-store";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresEntityStore } from "@/lib/persistence/postgres/authority-stores";
import {
  PostgresJobVerificationEvidenceStore,
  PostgresJobWorkerInstanceStore
} from "@/lib/persistence/postgres/worker-runtime-stores";

type CrashScenario =
  | "before-provider-call"
  | "after-provider-acceptance"
  | "during-verification"
  | "during-retry-scheduling"
  | "after-completion-before-ack";

const scenario = process.env.GETDONE_WORKER_CRASH_SCENARIO as CrashScenario | undefined;
const connectionString = process.env.DATABASE_URL?.trim() ?? "";
const workerId = process.env.GETDONE_JOB_WORKER_ID?.trim() ?? "crash-worker";

const flagColumns = {
  allow_provider_dispatch: "allow_provider_dispatch",
  allow_status_start: "allow_status_start",
  allow_verification: "allow_verification",
  allow_retry_return: "allow_retry_return",
  allow_release: "allow_release"
} as const;

type GateName = keyof typeof flagColumns;

async function waitForGate(pool: Pool, requestId: string, gate: GateName) {
  const column = flagColumns[gate];
  for (;;) {
    const result = await pool.query<Record<string, boolean>>(
      `SELECT ${column} AS open
       FROM worker_crash_acceptance_control
       WHERE request_id=$1`,
      [requestId]
    );
    if (result.rows[0]?.open === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

class CrashAcceptanceProvider implements BusinessActionAdapter {
  readonly id = "crash-acceptance-provider";
  readonly version = "1.0.0";

  constructor(private readonly control: Pool) {}

  async execute(request: AuthorizedBusinessActionRequest) {
    await this.control.query(
      `UPDATE worker_crash_acceptance_control
       SET provider_execute_entered=true
       WHERE request_id=$1`,
      [request.id]
    );
    await waitForGate(this.control, request.id, "allow_provider_dispatch");

    const behavior = await this.control.query<{ provider_behavior: string }>(
      `UPDATE worker_crash_acceptance_control
       SET dispatch_attempts=dispatch_attempts+1
       WHERE request_id=$1
       RETURNING provider_behavior`,
      [request.id]
    );

    if (behavior.rows[0]?.provider_behavior === "retryable-failure") {
      return createBusinessActionAdapterResult({
        source: "business-action-adapter",
        requestId: request.id,
        adapterId: this.id,
        adapterVersion: this.version,
        status: "failed",
        retryable: true,
        retryClass: "transport",
        observedAt: new Date().toISOString()
      });
    }

    await this.control.query(
      `UPDATE worker_crash_acceptance_control
       SET side_effect_count=side_effect_count+1,
           provider_state='accepted'
       WHERE request_id=$1`,
      [request.id]
    );

    return createBusinessActionAdapterResult({
      source: "business-action-adapter",
      requestId: request.id,
      adapterId: this.id,
      adapterVersion: this.version,
      status: "accepted",
      providerOperationId: `crash-provider:${request.id}`,
      retryable: false,
      retryClass: "none",
      observedAt: new Date().toISOString()
    });
  }

  async status(input: { requestId: string; providerOperationId: string }) {
    await waitForGate(this.control, input.requestId, "allow_status_start");
    await this.control.query(
      `UPDATE worker_crash_acceptance_control
       SET status_started=true,
           verification_calls=verification_calls+1
       WHERE request_id=$1`,
      [input.requestId]
    );
    await waitForGate(this.control, input.requestId, "allow_verification");
    await this.control.query(
      `UPDATE worker_crash_acceptance_control
       SET provider_state='completed'
       WHERE request_id=$1`,
      [input.requestId]
    );
    return createBusinessActionStatus({
      source: "business-action-adapter",
      requestId: input.requestId,
      providerOperationId: input.providerOperationId,
      adapterId: this.id,
      adapterVersion: this.version,
      state: "completed",
      observedAt: new Date().toISOString()
    });
  }
}

class CrashBarrierStore implements DurableJobWorkStore {
  readonly descriptor;

  constructor(
    private readonly inner: PostgresDurableJobStore,
    private readonly control: Pool,
    private readonly activeScenario: CrashScenario
  ) {
    this.descriptor = inner.descriptor;
  }

  enqueue(input: Parameters<DurableJobWorkStore["enqueue"]>[0]) {
    return this.inner.enqueue(input);
  }

  claimAtomic(input: Parameters<DurableJobWorkStore["claimAtomic"]>[0]) {
    return this.inner.claimAtomic(input);
  }

  heartbeat(input: Parameters<DurableJobWorkStore["heartbeat"]>[0]) {
    return this.inner.heartbeat(input);
  }

  async release(input: Parameters<DurableJobWorkStore["release"]>[0]) {
    if (this.activeScenario === "after-completion-before-ack") {
      await this.control.query(
        `UPDATE worker_crash_acceptance_control
         SET release_started=true
         WHERE job_id=$1`,
        [input.lease.jobId]
      );
      const row = await this.control.query<{ request_id: string }>(
        "SELECT request_id FROM worker_crash_acceptance_control WHERE job_id=$1",
        [input.lease.jobId]
      );
      await waitForGate(
        this.control,
        row.rows[0]!.request_id,
        "allow_release"
      );
    }
    return this.inner.release(input);
  }

  async scheduleRetry(input: Parameters<DurableJobWorkStore["scheduleRetry"]>[0]) {
    const receipt = await this.inner.scheduleRetry(input);
    if (this.activeScenario === "during-retry-scheduling") {
      await this.control.query(
        `UPDATE worker_crash_acceptance_control
         SET retry_schedule_started=true
         WHERE job_id=$1`,
        [input.jobId]
      );
      const row = await this.control.query<{ request_id: string }>(
        "SELECT request_id FROM worker_crash_acceptance_control WHERE job_id=$1",
        [input.jobId]
      );
      await waitForGate(
        this.control,
        row.rows[0]!.request_id,
        "allow_retry_return"
      );
    }
    return receipt;
  }

  deadLetter(input: Parameters<DurableJobWorkStore["deadLetter"]>[0]) {
    return this.inner.deadLetter(input);
  }

  cancel(input: Parameters<DurableJobWorkStore["cancel"]>[0]) {
    return this.inner.cancel(input);
  }

  recoverExpired(input: Parameters<DurableJobWorkStore["recoverExpired"]>[0]) {
    return this.inner.recoverExpired(input);
  }

  listReady(input: Parameters<DurableJobWorkStore["listReady"]>[0]) {
    return this.inner.listReady(input);
  }

  getRuntimeSnapshot(jobId: string) {
    return this.inner.getRuntimeSnapshot(jobId);
  }
}

async function main() {
    if (!scenario) throw new Error("GETDONE_WORKER_CRASH_SCENARIO is required");
    if (!connectionString) throw new Error("DATABASE_URL is required");

    const database = new PostgresDatabase({
      connectionString,
      maxConnections: 4,
      statementTimeoutMs: 30_000,
      connectionTimeoutMs: 5_000,
      runtimeRole: "getdone_tenant_runtime",
      ssl: process.env.GETDONE_DB_SSL !== "false"
    });
    const control = new Pool({
      connectionString,
      max: 2,
      application_name: "getdone-worker-crash-control-child",
      ssl: process.env.GETDONE_DB_SSL === "false"
        ? false
        : { rejectUnauthorized: true }
    });

    try {
      const innerStore = new PostgresDurableJobStore(database, {
        maxAttempts: 5,
        recoveryDelayMs: 0
      });
      const store = new CrashBarrierStore(innerStore, control, scenario);
      const worker = new DurableJobWorker(
        store,
        {
          workerId,
          leaseSeconds: 2,
          heartbeatSeconds: 1,
          batchSize: 1,
          retryBaseDelayMs: 60_000,
          maxAttempts: 5
        }
      );

      const provider = new CrashAcceptanceProvider(control);
      const orchestrator = new BusinessActionExecutionOrchestrator(
        new StaticBusinessActionAdapterRegistry([
          { capability: "http.request", adapter: provider }
        ]),
        new PostgresBusinessActionExecutionStore(database),
        { maxStatusPolls: 2, pollIntervalMs: 0 }
      );
      const handler = new RoutedJobExecutionHandler(
        new PostgresJobExecutionSpecStore(database),
        orchestrator,
        undefined,
        {
          jobs: new PostgresEntityStore<JobRecord>(database, "job"),
          verificationEvidence: new PostgresJobVerificationEvidenceStore(database)
        }
      );

      const service = new PersistentJobWorkerService(
        {
          recoverExpired: (limit?: number) => worker.recoverExpired(limit),
          runOnce: (options?: { shouldStop?: () => boolean }) =>
            worker.runOnce(handler, options)
        },
        new PostgresJobWorkerInstanceStore(database),
        {
          workerId,
          pollIntervalMs: 100,
          errorBackoffMs: 100,
          recoveryLimit: 10
        }
      );

      await service.runCycle();
      if (service.snapshot().cycles !== 1) {
        throw new Error("Crash acceptance worker did not complete exactly one cycle");
      }
    } finally {
      await database.close();
      await control.end();
    }
}

void main().catch((error) => {
  console.error("Worker crash acceptance child failed", error);
  process.exitCode = 1;
});
