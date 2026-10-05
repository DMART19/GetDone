import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { JobService, type JobRecord, type JobStores } from "@/lib/domain/services/job-service";
import type { TaskRecord } from "@/lib/domain/services/task-service";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import {
  ConfiguredHttpActionAdapter,
  type ConfiguredHttpOperation
} from "@/lib/execution/adapters/configured-http-action";
import { StaticBusinessActionAdapterRegistry } from "@/lib/execution/adapters/business-action-registry";
import { BusinessActionExecutionOrchestrator } from "@/lib/execution/business-action-orchestrator";
import { DurableJobEngine } from "@/lib/execution/durable-job-engine";
import { RoutedJobExecutionHandler } from "@/lib/execution/job-execution-router";
import { PostgresCurrentExecutionAdmissionGate } from "@/lib/execution/current-execution-admission";
import { DurableJobWorker } from "@/lib/execution/job-worker-runtime";
import { MvpJobRuntime } from "@/lib/execution/mvp-job-runtime.server";
import { seedLiveAcceptanceAuthority } from "@/lib/execution/live-acceptance-authority";
import { PostgresAuthorizationGrantStore, PostgresEntityStore, PostgresVerificationReceiptStore } from "@/lib/persistence/postgres/authority-stores";
import { PostgresControlPlaneTransactionManager } from "@/lib/persistence/postgres/transaction-manager";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresBusinessActionExecutionStore } from "@/lib/persistence/postgres/execution-stores";
import { PostgresJobExecutionSpecStore } from "@/lib/persistence/postgres/job-execution-spec-store";
import { PostgresDurableJobStore } from "@/lib/persistence/postgres/job-store";
import { PostgresJobVerificationEvidenceStore } from "@/lib/persistence/postgres/worker-runtime-stores";

const enabled = process.env.GETDONE_HTTP_STAGING_ACCEPTANCE === "true";
const liveDescribe = enabled ? describe.sequential : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "";
const runId = (process.env.GITHUB_RUN_ID ?? crypto.randomUUID()).replace(/[^A-Za-z0-9_-]/g, "");

const scope = Object.freeze({
  userId: "owner-http-staging",
  portfolioId: "portfolio-http-staging",
  companyId: "company-http-staging",
  environment: "staging" as const
});

interface ProviderRecord {
  externalId: string;
  requestId: string;
  state: string;
  scenario: string;
  actionCalls: number;
  idempotencyKeyHash: string;
  cancellationReason: string | null;
}

interface AcceptanceArtifact {
  runId: string;
  generatedAt: string;
  provider: "configured-https";
  endpointOriginHash: string;
  realHttps: boolean;
  cases: Array<{
    name: string;
    outcome: string;
    providerOperationId?: string;
    providerRecordHash?: string;
    actionCalls?: number;
  }>;
}

let origin = "";
let tokenA = "";
let tokenB = "";
let controlToken = "";
const credentialEnv: Record<string, string> = {};

const artifact: AcceptanceArtifact = {
  runId,
  generatedAt: new Date().toISOString(),
  provider: "configured-https",
  endpointOriginHash: "",
  realHttps: true,
  cases: []
};

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is required for configured HTTPS staging acceptance");
  return value;
}

function database() {
  return new PostgresDatabase({
    connectionString: databaseUrl,
    maxConnections: 6,
    ssl: process.env.GETDONE_DB_SSL !== "false"
  });
}

function job(name: string, now: string): JobRecord {
  const id = "job-http-" + runId + "-" + name;
  const taskId = "task-http-" + runId + "-" + name;
  const grantHash = sha256Hex({ id, type: "grant" });
  return Object.freeze({
    id,
    correlationId: "corr-http-" + runId + "-" + name,
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    state: "queued",
    taskId,
    attempt: 0,
    maxAttempts: 5,
    authorizationGrantId: "grant-" + id,
    authorizationGrantHash: grantHash,
    authorizationConsumption: {
      id: "consumption-" + id,
      grantId: "grant-" + id,
      grantHash,
      consumerType: "task" as const,
      consumerId: taskId,
      scope,
      planHash: sha256Hex({ id, type: "plan" }),
      stepHash: sha256Hex({ id, type: "step" }),
      consumedAt: now,
      consumptionHash: sha256Hex({ id, type: "consumption" })
    },
    verificationEvidenceIds: Object.freeze([]),
    version: 2,
    updatedAt: now
  });
}

function actionRequest(
  authoritative: JobRecord,
  name: string,
  operation: string,
  timeoutMs = 30_000
): AuthorizedBusinessActionRequest {
  const input = {
    companyId: scope.companyId,
    operation,
    payload: {
      case: name,
      runId
    }
  };
  return Object.freeze({
    id: "http-action-" + runId + "-" + name,
    correlationId: authoritative.correlationId,
    jobId: authoritative.id,
    scope,
    capability: "http.request",
    input,
    inputHash: sha256Hex(input),
    authorizationConsumptionHash: authoritative.authorizationConsumption!.consumptionHash,
    credentialLeaseId: "http-lease-" + authoritative.id,
    idempotencyKey: "http-idempotency-" + runId + "-" + name,
    timeoutMs,
    attempt: 1
  });
}

function operations(): ConfiguredHttpOperation[] {
  const auth = {
    credentialProviderId: "configured-http-staging",
    minimumScopes: ["execute", "verify", "cancel"]
  };
  const follow = (path: string) => ({
    url: origin + path + "/{providerOperationId}",
    method: "GET" as const
  });
  return [
    { name: "stage.normal", companyId: scope.companyId, environment: "staging", url: origin + "/action/normal", ...auth },
    {
      name: "stage.consequential",
      companyId: scope.companyId,
      environment: "staging",
      url: origin + "/action/consequential",
      ...auth,
      consequential: true,
      verification: follow("/verify")
    },
    {
      name: "stage.cancel",
      companyId: scope.companyId,
      environment: "staging",
      url: origin + "/action/cancel",
      ...auth,
      consequential: true,
      verification: follow("/verify"),
      cancellation: {
        url: origin + "/cancel/{providerOperationId}",
        method: "POST"
      }
    },
    { name: "stage.client4xx", companyId: scope.companyId, environment: "staging", url: origin + "/action/client-4xx", ...auth },
    { name: "stage.server5xx", companyId: scope.companyId, environment: "staging", url: origin + "/action/server-5xx", ...auth },
    {
      name: "stage.slow",
      companyId: scope.companyId,
      environment: "staging",
      url: origin + "/action/slow",
      ...auth,
      consequential: true,
      verification: follow("/verify")
    },
    {
      name: "stage.oversized",
      companyId: scope.companyId,
      environment: "staging",
      url: origin + "/action/oversized",
      ...auth,
      maxResponseBytes: 256
    },
    {
      name: "stage.malicious",
      companyId: scope.companyId,
      environment: "staging",
      url: origin + "/action/malicious-operation-id",
      ...auth
    },
    {
      name: "stage.dns",
      companyId: scope.companyId,
      environment: "staging",
      url: "https://getdone-staging-network-failure.invalid/action",
      ...auth
    },
    { name: "stage.rotated", companyId: scope.companyId, environment: "staging", url: origin + "/action/normal", ...auth }
  ];
}

function adapter() {
  return new ConfiguredHttpActionAdapter(operations());
}

function runtime(
  db: PostgresDatabase,
  configured: ConfiguredHttpActionAdapter,
  startMs: number,
  options: { maxStatusPolls?: number; maxAttempts?: number; pollIntervalMs?: number } = {}
) {
  let clockMs = startMs;
  const now = () => new Date(clockMs);
  const queue = new PostgresDurableJobStore(db, {
    maxAttempts: options.maxAttempts ?? 3,
    recoveryDelayMs: 0
  });
  const worker = new DurableJobWorker(queue, {
    workerId: "http-staging-worker-" + crypto.randomUUID(),
    leaseSeconds: 30,
    heartbeatSeconds: 5,
    batchSize: 4,
    concurrency: 1,
    retryBaseDelayMs: 0,
    maxAttempts: options.maxAttempts ?? 3
  }, now);
  const engine = new DurableJobEngine(queue, worker);
  const specs = new PostgresJobExecutionSpecStore(db);
  const jobs = new PostgresEntityStore<JobRecord>(db, "job");
  const business = new BusinessActionExecutionOrchestrator(
    new StaticBusinessActionAdapterRegistry([{ capability: "http.request", adapter: configured }]),
    new PostgresBusinessActionExecutionStore(db),
    {
      maxStatusPolls: options.maxStatusPolls ?? 8,
      pollIntervalMs: options.pollIntervalMs ?? 250,
      credentialBroker: {
        resolve: async ({ request, requirement }) => ({
          leaseId: request.credentialLeaseId!,
          leaseHash: sha256Hex({ leaseId: request.credentialLeaseId, runId }),
          providerId: requirement.providerId,
          capability: request.capability,
          grantedScopes: [...requirement.requiredScopes],
          material: credentialEnv.HTTP_STAGE_TOKEN,
          issuedAt: new Date(startMs).toISOString(),
          expiresAt: new Date(startMs + 60 * 60_000).toISOString()
        })
      }
    }
  );
  const jobService = new JobService(new PostgresControlPlaneTransactionManager<JobStores>(
    db,
    (client) => ({
      jobs: new PostgresEntityStore<JobRecord>(client, "job"),
      authorizationGrants: new PostgresAuthorizationGrantStore(client),
      verificationReceipts: new PostgresVerificationReceiptStore(client)
    })
  ), now);
  const handler = new RoutedJobExecutionHandler(
    specs,
    business,
    undefined,
    {
      jobs,
      tasks: new PostgresEntityStore<TaskRecord>(db, "task"),
      grants: new PostgresAuthorizationGrantStore(db),
      admission: new PostgresCurrentExecutionAdmissionGate(db, now),
      verificationEvidence: new PostgresJobVerificationEvidenceStore(db),
      lifecycle: jobService
    }
  );
  return {
    queue,
    jobs,
    business,
    mvp: new MvpJobRuntime(engine, specs, handler, jobs, now),
    advance(milliseconds = 5_000) {
      clockMs += milliseconds;
    }
  };
}

async function runUntilTerminal(
  value: ReturnType<typeof runtime>,
  jobId: string,
  maxRuns = 8
) {
  for (let index = 0; index < maxRuns; index += 1) {
    await value.mvp.runOnce();
    const snapshot = await value.queue.getRuntimeSnapshot(jobId);
    if (snapshot && ["released", "dead-lettered", "cancelled"].includes(snapshot.state)) {
      return snapshot;
    }
    value.advance();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Configured HTTPS staging Job did not reach terminal state");
}

async function inspectRequest(requestId: string): Promise<ProviderRecord | null> {
  const response = await fetch(origin + "/inspect/request/" + encodeURIComponent(requestId), {
    headers: { authorization: "Bearer " + controlToken }
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Controlled staging inspection failed");
  const body = await response.json() as { ok: boolean; record: ProviderRecord };
  return body.record;
}

async function rotateProviderCredential(token: string) {
  const response = await fetch(origin + "/control/rotate", {
    method: "POST",
    headers: {
      authorization: "Bearer " + controlToken,
      "content-type": "application/json"
    },
    body: JSON.stringify({ token })
  });
  if (!response.ok) throw new Error("Controlled staging credential rotation failed");
}

function recordCase(value: AcceptanceArtifact["cases"][number]) {
  artifact.cases.push(value);
}

liveDescribe("configured HTTPS real staging acceptance", () => {
  beforeAll(async () => {
    origin = required("GETDONE_HTTP_STAGING_ORIGIN").replace(/\/$/, "");
    tokenA = required("GETDONE_HTTP_STAGING_TOKEN_A");
    tokenB = required("GETDONE_HTTP_STAGING_TOKEN_B");
    controlToken = required("GETDONE_HTTP_STAGING_CONTROL_TOKEN");
    credentialEnv.HTTP_STAGE_TOKEN = tokenA;
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:") throw new Error("Configured staging origin must be real HTTPS");
    artifact.endpointOriginHash = sha256Hex(origin);

    const health = await fetch(origin + "/health");
    if (!health.ok) throw new Error("Controlled staging HTTPS endpoint is not healthy");

    const db = database();
    try {
      await db.query(`TRUNCATE
        business_action_verification_evidence,
        business_action_executions,
        job_runtime_events,
        job_execution_outcomes,
        job_recovery_records,
        job_dead_letters,
        job_retry_schedule,
        job_runtime_transactions,
        job_leases,
        job_runtime_state,
        job_execution_specs,
        control_plane_entities
        RESTART IDENTITY CASCADE`);
    } finally {
      await db.close();
    }
  }, 30_000);

  afterAll(() => {
    mkdirSync("test-results", { recursive: true });
    writeFileSync(
      "test-results/configured-http-staging-acceptance.json",
      JSON.stringify({ ...artifact, generatedAt: new Date().toISOString() }, null, 2) + "\n"
    );
  });

  it("executes a normal configured HTTPS action through the governed Job pipeline", async () => {
    const db = database();
    try {
      const value = runtime(db, adapter(), Date.now());
      const authoritative = job("normal", new Date().toISOString());
      const action = actionRequest(authoritative, "normal", "stage.normal");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, action);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("released");
      const provider = await inspectRequest(action.id);
      expect(provider).toMatchObject({ state: "active", scenario: "normal", actionCalls: 1 });
      const record = await new PostgresBusinessActionExecutionStore(db).get(action.id);
      recordCase({
        name: "normal-execution",
        outcome: "released",
        providerOperationId: record?.providerOperationId,
        providerRecordHash: sha256Hex(provider),
        actionCalls: provider?.actionCalls
      });
    } finally {
      await db.close();
    }
  });

  it("verifies a consequential action through the independent HTTPS verification endpoint", async () => {
    const db = database();
    try {
      const value = runtime(db, adapter(), Date.now());
      const authoritative = job("consequential", new Date().toISOString());
      const action = actionRequest(authoritative, "consequential", "stage.consequential");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, action);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("released");
      const record = await new PostgresBusinessActionExecutionStore(db).get(action.id);
      expect(record?.state).toBe("completed");
      expect(record?.latestStatusHash).toMatch(/^[a-f0-9]{64}$/);
      const provider = await inspectRequest(action.id);
      recordCase({
        name: "consequential-verification",
        outcome: "verified-and-released",
        providerOperationId: record?.providerOperationId,
        providerRecordHash: sha256Hex(provider)
      });
    } finally {
      await db.close();
    }
  });

  it("cancels through the configured HTTPS cancellation surface", async () => {
    const db = database();
    try {
      const value = runtime(db, adapter(), Date.now(), { maxStatusPolls: 0 });
      const authoritative = job("cancel", new Date().toISOString());
      const action = actionRequest(authoritative, "cancel", "stage.cancel");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, action);
      await value.mvp.runOnce();
      const before = await new PostgresBusinessActionExecutionStore(db).get(action.id);
      expect(before?.providerOperationId).toBeTruthy();

      const cancelled = await value.business.cancel(action, "controlled staging cancellation");
      expect(cancelled.record.state).toBe("cancelled");
      const provider = await inspectRequest(action.id);
      expect(provider).toMatchObject({
        state: "cancelled",
        cancellationReason: "controlled staging cancellation"
      });
      recordCase({
        name: "cancellation",
        outcome: "provider-cancelled",
        providerOperationId: before?.providerOperationId,
        providerRecordHash: sha256Hex(provider)
      });
    } finally {
      await db.close();
    }
  });

  it("fails closed on real HTTPS 4xx without creating a provider object", async () => {
    const db = database();
    try {
      const value = runtime(db, adapter(), Date.now(), { maxAttempts: 1 });
      const authoritative = job("client4xx", new Date().toISOString());
      const action = actionRequest(authoritative, "client4xx", "stage.client4xx");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, action);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("dead-lettered");
      expect(await inspectRequest(action.id)).toBeNull();
      expect((await new PostgresBusinessActionExecutionStore(db).get(action.id))?.state).toBe("rejected");
      recordCase({ name: "4xx", outcome: "dead-lettered-no-provider-object" });
    } finally {
      await db.close();
    }
  });

  it("retries a real HTTPS 5xx and succeeds on the controlled provider's second attempt", async () => {
    const db = database();
    try {
      const value = runtime(db, adapter(), Date.now(), { maxAttempts: 3 });
      const authoritative = job("server5xx", new Date().toISOString());
      const action = actionRequest(authoritative, "server5xx", "stage.server5xx");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, action);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("released");
      const provider = await inspectRequest(action.id);
      expect(provider).toMatchObject({ state: "active", scenario: "server-5xx" });
      recordCase({
        name: "5xx-retry",
        outcome: "retry-then-released",
        providerRecordHash: sha256Hex(provider),
        actionCalls: provider?.actionCalls
      });
    } finally {
      await db.close();
    }
  });

  it("recovers a slow timeout through the same idempotency lineage and verifies the reserved provider object", async () => {
    const db = database();
    try {
      const value = runtime(db, adapter(), Date.now(), {
        maxAttempts: 3,
        maxStatusPolls: 10,
        pollIntervalMs: 250
      });
      const authoritative = job("slow", new Date().toISOString());
      const action = actionRequest(authoritative, "slow", "stage.slow", 250);
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, action);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("released");
      const provider = await inspectRequest(action.id);
      expect(provider?.state).toBe("active");
      expect(provider?.actionCalls).toBeGreaterThanOrEqual(2);
      recordCase({
        name: "slow-timeout",
        outcome: "same-lineage-retry-and-verified",
        providerRecordHash: sha256Hex(provider),
        actionCalls: provider?.actionCalls
      });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("rejects an oversized real HTTPS response before buffering it", async () => {
    const db = database();
    try {
      const value = runtime(db, adapter(), Date.now(), { maxAttempts: 1 });
      const authoritative = job("oversized", new Date().toISOString());
      const action = actionRequest(authoritative, "oversized", "stage.oversized");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, action);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("dead-lettered");
      const provider = await inspectRequest(action.id);
      expect(provider?.scenario).toBe("oversized");
      recordCase({
        name: "oversized-response",
        outcome: "dead-lettered-after-size-guard",
        providerRecordHash: sha256Hex(provider)
      });
    } finally {
      await db.close();
    }
  });

  it("fails closed on a malicious provider operation ID", async () => {
    const db = database();
    try {
      const value = runtime(db, adapter(), Date.now(), { maxAttempts: 1 });
      const authoritative = job("malicious", new Date().toISOString());
      const action = actionRequest(authoritative, "malicious", "stage.malicious");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, action);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("dead-lettered");
      const provider = await inspectRequest(action.id);
      expect(provider?.scenario).toBe("malicious-operation-id");
      expect((await new PostgresBusinessActionExecutionStore(db).get(action.id))).toBeNull();
      recordCase({
        name: "malicious-operation-id",
        outcome: "validation-blocked-before-lineage-persistence",
        providerRecordHash: sha256Hex(provider)
      });
    } finally {
      await db.close();
    }
  });

  it("classifies a real DNS/network failure as retryable transport failure and dead-letters at the configured attempt ceiling", async () => {
    const db = database();
    try {
      const value = runtime(db, adapter(), Date.now(), { maxAttempts: 1 });
      const authoritative = job("dns", new Date().toISOString());
      const action = actionRequest(authoritative, "dns", "stage.dns", 2_000);
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, action);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("dead-lettered");
      const record = await new PostgresBusinessActionExecutionStore(db).get(action.id);
      expect(record).toMatchObject({ state: "failed", retryable: true, retryClass: "transport" });
      recordCase({ name: "dns-network-failure", outcome: "retryable-transport-dead-letter" });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("rotates the real staging credential and proves the old credential is rejected while the new credential succeeds", async () => {
    await rotateProviderCredential(tokenB);
    const oldResponse = await fetch(origin + "/action/normal", {
      method: "POST",
      headers: {
        authorization: "Bearer " + tokenA,
        "content-type": "application/json",
        "idempotency-key": "old-credential-probe"
      },
      body: JSON.stringify({
        requestId: "old-credential-probe",
        jobId: "probe",
        companyId: scope.companyId,
        payload: {}
      })
    });
    expect(oldResponse.status).toBe(401);

    credentialEnv.HTTP_STAGE_TOKEN = tokenB;
    const db = database();
    try {
      const value = runtime(db, adapter(), Date.now());
      const authoritative = job("rotated", new Date().toISOString());
      const action = actionRequest(authoritative, "rotated", "stage.rotated");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, action);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("released");
      const provider = await inspectRequest(action.id);
      expect(provider?.state).toBe("active");
      recordCase({
        name: "credential-rotation",
        outcome: "old-rejected-new-released",
        providerRecordHash: sha256Hex(provider)
      });
    } finally {
      await db.close();
    }
  });
});
