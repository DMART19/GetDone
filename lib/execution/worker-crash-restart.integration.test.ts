import { spawn, spawnSync } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { CAPABILITY_REGISTRY_HASH, CAPABILITY_REGISTRY_VERSION } from "@/lib/domain/capabilities";
import { CURRENT_POLICY_REGISTRY_HASH, CURRENT_POLICY_VERSION } from "@/lib/domain/policy-registry";
import { POLICY_ENGINE_VERSION, POLICY_RULES_HASH } from "@/lib/planning/policy-engine";
import { JobService, type JobStores } from "@/lib/domain/services/job-service";
import { TaskService, type TaskRecord, type TaskStores } from "@/lib/domain/services/task-service";
import type { AuthorizationGrant } from "@/lib/authorization/grants";
import { PostgresAuthorizationGrantStore, PostgresVerificationReceiptStore } from "@/lib/persistence/postgres/authority-stores";
import { PostgresControlPlaneTransactionManager } from "@/lib/persistence/postgres/transaction-manager";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import {
  createPersistedJobExecutionSpec
} from "@/lib/execution/job-execution-router";
import { createJobQueueEnvelope } from "@/lib/execution/job-runtime-contracts";
import { PostgresEntityStore } from "@/lib/persistence/postgres/authority-stores";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresJobExecutionSpecStore } from "@/lib/persistence/postgres/job-execution-spec-store";
import { PostgresDurableJobStore } from "@/lib/persistence/postgres/job-store";

type CrashScenario =
  | "before-provider-call"
  | "after-provider-acceptance"
  | "during-verification"
  | "during-retry-scheduling"
  | "after-completion-before-ack";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const integrationDescribe = enabled ? describe.sequential : describe.skip;
const baseConnectionString = process.env.DATABASE_URL?.trim() ?? "";
const ssl = process.env.GETDONE_DB_SSL === "false"
  ? false
  : { rejectUnauthorized: true };

const scope = Object.freeze({
  userId: "owner-crash",
  portfolioId: "portfolio-crash",
  companyId: "company-crash",
  environment: "staging" as const
});

interface ControlRow {
  scenario: CrashScenario;
  job_id: string;
  request_id: string;
  provider_behavior: "accepted" | "retryable-failure";
  provider_execute_entered: boolean;
  status_started: boolean;
  retry_schedule_started: boolean;
  release_started: boolean;
  dispatch_attempts: number;
  side_effect_count: number;
  verification_calls: number;
  provider_state: string;
}

function quoteIdentifier(value: string) {
  return '"' + value.replaceAll('"', '""') + '"';
}

function databaseUrl(name: string) {
  const url = new URL(baseConnectionString);
  url.pathname = `/${name}`;
  return url.toString();
}

function runMigrations(connectionString: string) {
  const result = spawnSync(process.execPath, ["scripts/migrate-postgres.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: connectionString,
      GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false"
    },
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(
      `Migration failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
}

function ids(scenario: CrashScenario) {
  const suffix = scenario.replaceAll("-", "_");
  return {
    jobId: `job_crash_${suffix}`,
    taskId: `task_crash_${suffix}`,
    requestId: `action_crash_${suffix}`,
    consumptionHash: `consumption_crash_${suffix}`
  };
}

function crashCommand(type: string, key: string) {
  return createCommandEnvelope({
    commandId: `cmd_${key}`, actor: { type: "user", id: scope.userId }, scope,
    correlationId: `correlation_${key}`, environment: "staging", idempotencyKey: key,
    provenance: "worker-crash-acceptance", requestedMutation: { type }
  });
}

function crashGrant(scenario: CrashScenario, at: string): AuthorizationGrant {
  const value = ids(scenario); const issuedAt = new Date(at);
  const base = {
    id: `grant_${value.jobId}`, status: "active" as const, disposition: "AUTO" as const, scope,
    planId: `plan_${value.jobId}`, planVersion: 1, planHash: `plan_${value.jobId}`,
    stepId: `step_${value.jobId}`, stepHash: `step_${value.jobId}`, capabilityNames: Object.freeze(["http.request"]),
    executionLimits: Object.freeze({ environment: "staging" as const, deadline: new Date(issuedAt.getTime()+30*60_000).toISOString(), expectedDurationSeconds: 30, retryable: true, maxJobCostCents: 0 }),
    validationReceiptId: `validation_${value.jobId}`, validationReceiptHash: sha256Hex({ scenario, type:"validation" }),
    policySnapshotId: `policy_${value.jobId}`, policySnapshotHash: sha256Hex({ scenario, type:"policy" }),
    policyVersion: CURRENT_POLICY_VERSION, policyRegistryHash: CURRENT_POLICY_REGISTRY_HASH,
    policyEngineVersion: POLICY_ENGINE_VERSION, policyRulesHash: POLICY_RULES_HASH,
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION, capabilityRegistryHash: CAPABILITY_REGISTRY_HASH,
    actor: { type:"user" as const, id:scope.userId }, issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime()+30*60_000).toISOString()
  };
  return Object.freeze({ ...base, grantHash: sha256Hex(base) });
}

function actionRequest(
  scenario: CrashScenario
): AuthorizedBusinessActionRequest {
  const value = ids(scenario);
  const input = {
    companyId: scope.companyId,
    operation: "crash.acceptance",
    payload: { scenario }
  };
  return Object.freeze({
    id: value.requestId,
    jobId: value.jobId,
    scope,
    capability: "http.request",
    input,
    inputHash: sha256Hex(input),
    authorizationConsumptionHash: value.consumptionHash,
    idempotencyKey: `idempotency_${value.requestId}`,
    timeoutMs: 30_000,
    attempt: 1
  });
}

function initialGates(scenario: CrashScenario) {
  return {
    allowProviderDispatch: scenario !== "before-provider-call",
    allowStatusStart: [
      "during-verification",
      "after-completion-before-ack"
    ].includes(scenario),
    allowVerification: scenario === "after-completion-before-ack",
    allowRetryReturn: scenario !== "during-retry-scheduling",
    allowRelease: scenario !== "after-completion-before-ack"
  };
}

interface SpawnedWorker {
  child: ReturnType<typeof spawn>;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): string;
}

function spawnWorker(
  connectionString: string,
  scenario: CrashScenario,
  workerId: string
): SpawnedWorker {
  const child = spawn(
    process.execPath,
    [
      "--require",
      "./scripts/register-worker-alias.cjs",
      "dist-worker-acceptance/lib/execution/worker-crash-acceptance-child.js"
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: connectionString,
        GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false",
        GETDONE_POSTGRES_INTEGRATION: "true",
        GETDONE_WORKER_CRASH_SCENARIO: scenario,
        GETDONE_JOB_WORKER_ID: workerId,
        GETDONE_WORKER_ALIAS_ROOT: "dist-worker-acceptance"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk) => { stdout += chunk; });
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }
  );
  return {
    child,
    done,
    output: () => `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`
  };
}

async function expectCleanExit(worker: SpawnedWorker) {
  const result = await worker.done;
  if (result.code !== 0) {
    throw new Error(
      `Worker exited unexpectedly with code=${result.code} signal=${result.signal}\n${worker.output()}`
    );
  }
}

async function killHard(worker: SpawnedWorker) {
  const killed = worker.child.kill("SIGKILL");
  expect(killed).toBe(true);
  const result = await worker.done;
  expect(result.signal).toBe("SIGKILL");
}

async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 12_000,
  worker?: SpawnedWorker
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (
      worker
      && (worker.child.exitCode !== null || worker.child.signalCode !== null)
    ) {
      const result = await worker.done;
      throw new Error(
        `Worker exited before ${label}: code=${result.code} signal=${result.signal}\n${worker.output()}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for ${label}${worker ? `\n${worker.output()}` : ""}`
  );
}

integrationDescribe("worker crash/restart real PostgreSQL acceptance", () => {
  const databaseName = `getdone_worker_crash_${process.pid}_${Date.now()}`;
  let adminRoot: Pool;
  let admin: Pool;
  let connectionString: string;

  beforeAll(async () => {
    if (!baseConnectionString) throw new Error("DATABASE_URL is required");
    adminRoot = new Pool({
      connectionString: baseConnectionString,
      max: 2,
      application_name: "getdone-worker-crash-admin-root",
      ssl
    });
    await adminRoot.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await adminRoot.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    connectionString = databaseUrl(databaseName);
    runMigrations(connectionString);

    admin = new Pool({
      connectionString,
      max: 4,
      application_name: "getdone-worker-crash-admin",
      ssl
    });
    await admin.query(
      `CREATE TABLE worker_crash_acceptance_control (
        scenario text PRIMARY KEY,
        job_id text NOT NULL UNIQUE,
        request_id text NOT NULL UNIQUE,
        provider_behavior text NOT NULL
          CHECK (provider_behavior IN ('accepted','retryable-failure')),
        allow_provider_dispatch boolean NOT NULL DEFAULT false,
        allow_status_start boolean NOT NULL DEFAULT false,
        allow_verification boolean NOT NULL DEFAULT false,
        allow_retry_return boolean NOT NULL DEFAULT false,
        allow_release boolean NOT NULL DEFAULT false,
        provider_execute_entered boolean NOT NULL DEFAULT false,
        status_started boolean NOT NULL DEFAULT false,
        retry_schedule_started boolean NOT NULL DEFAULT false,
        release_started boolean NOT NULL DEFAULT false,
        dispatch_attempts integer NOT NULL DEFAULT 0,
        side_effect_count integer NOT NULL DEFAULT 0,
        verification_calls integer NOT NULL DEFAULT 0,
        provider_state text NOT NULL DEFAULT 'not-called'
      )`
    );
  }, 30_000);

  beforeEach(async () => {
    await admin.query(`TRUNCATE
      business_action_verification_evidence,
      business_action_executions,
      job_worker_instances,
      job_runtime_events,
      job_execution_outcomes,
      job_recovery_records,
      job_dead_letters,
      job_retry_schedule,
      job_runtime_transactions,
      job_leases,
      job_runtime_state,
      job_execution_specs,
      worker_crash_acceptance_control
      RESTART IDENTITY CASCADE`);
    await admin.query(
      "DELETE FROM control_plane_entities WHERE entity_type='job'"
    );
  });

  afterAll(async () => {
    if (admin) {
      await admin.query("DROP TABLE IF EXISTS worker_crash_acceptance_control");
      await admin.end();
    }
    if (adminRoot) {
      await adminRoot.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`
      );
      await adminRoot.end();
    }
  }, 30_000);

  async function seed(scenario: CrashScenario) {
    const at = new Date().toISOString();
    const value = ids(scenario);
    const job = authoritativeJob(scenario, at);
    const request = actionRequest(scenario);
    const gates = initialGates(scenario);

    const database = new PostgresDatabase({
      connectionString,
      maxConnections: 2,
      statementTimeoutMs: 30_000,
      connectionTimeoutMs: 5_000,
      ssl: process.env.GETDONE_DB_SSL !== "false"
    });
    try {
      const grant = crashGrant(scenario, at);
      const grants = new PostgresAuthorizationGrantStore(database);
      await grants.insert(grant);
      const taskService = new TaskService(new PostgresControlPlaneTransactionManager<TaskStores>(database, (client) => ({ tasks: new PostgresEntityStore<TaskRecord>(client, "task"), authorizationGrants: new PostgresAuthorizationGrantStore(client), verificationReceipts: new PostgresVerificationReceiptStore(client) })));
      await taskService.create({ id: value.taskId, reason: "Crash/restart acceptance", capabilityRequirements: ["http.request"] }, crashCommand("task.create", `create_${scenario}`));
      const task = await taskService.authorize(value.taskId, crashCommand("task.authorize", `authorize_${scenario}`), grant);
      await taskService.queue(value.taskId, crashCommand("task.queue", `queue_task_${scenario}`));
      if (!task.authorizationConsumption) throw new Error("Crash fixture authorization consumption missing");
      const jobService = new JobService(new PostgresControlPlaneTransactionManager<JobStores>(database, (client) => ({ jobs: new PostgresEntityStore<JobRecord>(client, "job"), authorizationGrants: new PostgresAuthorizationGrantStore(client), verificationReceipts: new PostgresVerificationReceiptStore(client) })));
      await jobService.create({ id:value.jobId, taskId:value.taskId, maxAttempts:5 }, crashCommand("job.create", `create_job_${scenario}`));
      const job = await jobService.queue(value.jobId, crashCommand("job.queue", `queue_job_${scenario}`), grant, task.authorizationConsumption);
      await new PostgresJobExecutionSpecStore(database).put(
        createPersistedJobExecutionSpec({
          kind: "business-action",
          jobId: job.id,
          authoritativeJobVersion: job.version,
          authoritativeJobHash: sha256Hex(job),
          request
        }, at)
      );
      await new PostgresDurableJobStore(database, {
        maxAttempts: 5,
        recoveryDelayMs: 0
      }).enqueue(createJobQueueEnvelope({
        id: `queue_${job.id}`,
        jobId: job.id,
        taskId: job.taskId,
        scope,
        authorizationConsumptionHash: task.authorizationConsumption.consumptionHash,
        idempotencyKey: `queue_${request.idempotencyKey}`,
        scheduledAt: at,
        createdAt: at
      }));
    } finally {
      await database.close();
    }

    await admin.query(
      `INSERT INTO worker_crash_acceptance_control(
        scenario,job_id,request_id,provider_behavior,
        allow_provider_dispatch,allow_status_start,allow_verification,
        allow_retry_return,allow_release
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        scenario,
        value.jobId,
        value.requestId,
        scenario === "during-retry-scheduling"
          ? "retryable-failure"
          : "accepted",
        gates.allowProviderDispatch,
        gates.allowStatusStart,
        gates.allowVerification,
        gates.allowRetryReturn,
        gates.allowRelease
      ]
    );
    return value;
  }

  async function control(scenario: CrashScenario) {
    const result = await admin.query<ControlRow>(
      "SELECT * FROM worker_crash_acceptance_control WHERE scenario=$1",
      [scenario]
    );
    return result.rows[0]!;
  }

  async function runtimeState(jobId: string) {
    const result = await admin.query<{ runtime_state: string }>(
      "SELECT runtime_state FROM job_runtime_state WHERE job_id=$1",
      [jobId]
    );
    return result.rows[0]?.runtime_state ?? null;
  }

  async function businessState(requestId: string) {
    const result = await admin.query<{ state: string }>(
      "SELECT state FROM business_action_executions WHERE request_id=$1",
      [requestId]
    );
    return result.rows[0]?.state ?? null;
  }

  async function evidenceCount(jobId: string) {
    const result = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM business_action_verification_evidence
       WHERE job_id=$1`,
      [jobId]
    );
    return Number(result.rows[0].count);
  }

  async function allowRecovery(scenario: CrashScenario) {
    await admin.query(
      `UPDATE worker_crash_acceptance_control
       SET allow_provider_dispatch=true,
           allow_status_start=true,
           allow_verification=true,
           allow_retry_return=true,
           allow_release=true
       WHERE scenario=$1`,
      [scenario]
    );
  }

  async function waitForLeaseExpiry(jobId: string) {
    await waitFor("expired worker lease", async () => {
      const result = await admin.query<{ expired: boolean }>(
        `SELECT COALESCE(bool_and(expires_at <= now()),false) AS expired
         FROM job_leases
         WHERE job_id=$1 AND state='active'`,
        [jobId]
      );
      return result.rows[0]?.expired === true;
    }, 8_000);
  }

  async function transactionCounts(jobId: string) {
    const result = await admin.query<{ operation: string; count: string }>(
      `SELECT operation,count(*)::text AS count
       FROM job_runtime_transactions
       WHERE job_id=$1
       GROUP BY operation
       ORDER BY operation`,
      [jobId]
    );
    return Object.fromEntries(
      result.rows.map((row) => [row.operation, Number(row.count)])
    ) as Record<string, number>;
  }

  async function runScenario(
    scenario: CrashScenario,
    marker: (value: { ids: ReturnType<typeof ids>; row: ControlRow }) => Promise<boolean>
  ) {
    const value = await seed(scenario);
    const first = spawnWorker(
      connectionString,
      scenario,
      `worker_first_${scenario.replaceAll("-", "_")}`
    );

    await waitFor(
      `${scenario} crash boundary`,
      async () => marker({ ids: value, row: await control(scenario) }),
      12_000,
      first
    );

    await killHard(first);
    await allowRecovery(scenario);

    if (scenario !== "during-retry-scheduling") {
      await waitForLeaseExpiry(value.jobId);
    }

    const second = spawnWorker(
      connectionString,
      scenario,
      `worker_restart_${scenario.replaceAll("-", "_")}`
    );
    await expectCleanExit(second);

    return {
      ids: value,
      row: await control(scenario),
      runtimeState: await runtimeState(value.jobId),
      businessState: await businessState(value.requestId),
      evidenceCount: await evidenceCount(value.jobId),
      transactions: await transactionCounts(value.jobId),
      retryRows: Number((await admin.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM job_retry_schedule WHERE job_id=$1",
        [value.jobId]
      )).rows[0].count)
    };
  }

  it("kills before provider dispatch and restart performs the side effect exactly once", async () => {
    const result = await runScenario(
      "before-provider-call",
      async ({ ids: value, row }) =>
        row.provider_execute_entered
        && row.dispatch_attempts === 0
        && await runtimeState(value.jobId) === "claimed"
    );

    expect(result).toMatchObject({
      runtimeState: "released",
      businessState: "completed",
      evidenceCount: 1
    });
    expect(result.row).toMatchObject({
      dispatch_attempts: 1,
      side_effect_count: 1,
      verification_calls: 1
    });
    expect(result.transactions.claim).toBe(2);
    expect(result.transactions["recover-expired"]).toBe(1);
    expect(result.transactions.release).toBe(1);
  }, 30_000);

  it("kills after provider acceptance and resumes by status without redispatch", async () => {
    const result = await runScenario(
      "after-provider-acceptance",
      async ({ ids: value, row }) =>
        row.side_effect_count === 1
        && row.verification_calls === 0
        && await businessState(value.requestId) === "accepted"
    );

    expect(result).toMatchObject({
      runtimeState: "released",
      businessState: "completed",
      evidenceCount: 1
    });
    expect(result.row).toMatchObject({
      dispatch_attempts: 1,
      side_effect_count: 1,
      verification_calls: 1
    });
    expect(result.transactions["recover-expired"]).toBe(1);
    expect(result.transactions.release).toBe(1);
  }, 30_000);

  it("kills during verification and restart re-verifies without repeating the side effect", async () => {
    const result = await runScenario(
      "during-verification",
      async ({ row }) =>
        row.status_started
        && row.verification_calls === 1
        && row.side_effect_count === 1
    );

    expect(result).toMatchObject({
      runtimeState: "released",
      businessState: "completed",
      evidenceCount: 1
    });
    expect(result.row.dispatch_attempts).toBe(1);
    expect(result.row.side_effect_count).toBe(1);
    expect(result.row.verification_calls).toBe(2);
    expect(result.transactions["recover-expired"]).toBe(1);
    expect(result.transactions.release).toBe(1);
  }, 30_000);

  it("kills after retry scheduling commit and restart does not duplicate the retry", async () => {
    const result = await runScenario(
      "during-retry-scheduling",
      async ({ ids: value, row }) =>
        row.retry_schedule_started
        && row.dispatch_attempts === 1
        && await runtimeState(value.jobId) === "retry-wait"
    );

    expect(result).toMatchObject({
      runtimeState: "retry-wait",
      businessState: "failed",
      evidenceCount: 1,
      retryRows: 1
    });
    expect(result.row).toMatchObject({
      dispatch_attempts: 1,
      side_effect_count: 0,
      verification_calls: 0
    });
    expect(result.transactions.claim).toBe(1);
    expect(result.transactions.retry).toBe(1);
    expect(result.transactions.release ?? 0).toBe(0);
    expect(result.transactions["recover-expired"] ?? 0).toBe(0);
  }, 30_000);

  it("kills after provider completion before Job release and restart acknowledges completion exactly once", async () => {
    const result = await runScenario(
      "after-completion-before-ack",
      async ({ ids: value, row }) =>
        row.release_started
        && row.side_effect_count === 1
        && await businessState(value.requestId) === "completed"
        && await evidenceCount(value.jobId) === 1
    );

    expect(result).toMatchObject({
      runtimeState: "released",
      businessState: "completed",
      evidenceCount: 1
    });
    expect(result.row).toMatchObject({
      dispatch_attempts: 1,
      side_effect_count: 1,
      verification_calls: 1
    });
    expect(result.transactions["recover-expired"]).toBe(1);
    expect(result.transactions.release).toBe(1);
  }, 30_000);
});
