import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  createCredentialBinding,
  createCredentialRequest,
  createSecretReference,
  issueCredentialLease
} from "@/lib/credentials/broker";
import {
  GovernedBusinessActionCredentialBroker,
  type CredentialDeliveryProvider
} from "@/lib/credentials/runtime-broker";
import { JobService, type JobRecord, type JobStores } from "@/lib/domain/services/job-service";
import type { TaskRecord } from "@/lib/domain/services/task-service";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import {
  ConfiguredWebhookActionAdapter,
  type ConfiguredWebhookOperation
} from "@/lib/execution/adapters/configured-webhook-action";
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
import { PostgresCredentialBrokerStore } from "@/lib/persistence/postgres/credential-broker-store";
import { PostgresBusinessActionExecutionStore } from "@/lib/persistence/postgres/execution-stores";
import { PostgresJobExecutionSpecStore } from "@/lib/persistence/postgres/job-execution-spec-store";
import { PostgresDurableJobStore } from "@/lib/persistence/postgres/job-store";
import { PostgresJobVerificationEvidenceStore } from "@/lib/persistence/postgres/worker-runtime-stores";

const enabled = process.env.GETDONE_WEBHOOK_STAGING_ACCEPTANCE === "true";
const liveDescribe = enabled ? describe.sequential : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "";
const runId = (process.env.GITHUB_RUN_ID ?? crypto.randomUUID()).replace(/[^A-Za-z0-9_-]/g, "");

const scope = Object.freeze({
  userId: "owner-webhook-staging",
  portfolioId: "portfolio-webhook-staging",
  companyId: "company-webhook-staging",
  environment: "staging" as const,
  resourceId: "resource-webhook-staging"
});

interface ProviderRecord {
  operationId: string;
  requestId: string;
  jobId: string;
  companyId: string;
  scenario: string;
  state: string;
  idempotencyKeyHash: string;
  bodyHash: string;
  signatureValid: boolean;
  deliveryAttempts: number;
  sideEffectCount: number;
  cancellationReason: string | null;
}

interface AcceptanceArtifact {
  runId: string;
  generatedAt: string;
  provider: "configured-webhook";
  realHttps: boolean;
  brokeredCredential: boolean;
  endpointOriginHash: string;
  cases: Array<{
    name: string;
    outcome: string;
    providerOperationId?: string;
    providerRecordHash?: string;
    deliveryAttempts?: number;
    sideEffectCount?: number;
  }>;
}

let origin = "";
let signingSecret = "";
let controlToken = "";

const artifact: AcceptanceArtifact = {
  runId,
  generatedAt: new Date().toISOString(),
  provider: "configured-webhook",
  realHttps: true,
  brokeredCredential: true,
  endpointOriginHash: "",
  cases: []
};

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is required for webhook staging acceptance");
  return value;
}

function database() {
  return new PostgresDatabase({
    connectionString: databaseUrl,
    maxConnections: 6,
    ssl: process.env.GETDONE_DB_SSL !== "false"
  });
}

function actionRequest(
  authoritative: JobRecord,
  name: string,
  operation: string,
  timeoutMs = 5_000
): AuthorizedBusinessActionRequest {
  const input = {
    companyId: scope.companyId,
    operation,
    payload: { case: name, runId }
  };
  return Object.freeze({
    id: "webhook-action-" + runId + "-" + name,
    correlationId: authoritative.correlationId,
    jobId: authoritative.id,
    scope,
    capability: "webhook.send",
    input,
    inputHash: sha256Hex(input),
    authorizationConsumptionHash: authoritative.authorizationConsumption!.consumptionHash,
    credentialLeaseId: "lease-" + authoritative.id,
    idempotencyKey: "webhook-idempotency-" + runId + "-" + name,
    timeoutMs,
    attempt: 1
  });
}

function operations(): ConfiguredWebhookOperation[] {
  const base = {
    companyId: scope.companyId,
    environment: "staging" as const,
    credentialProviderId: "webhook-staging",
    minimumScopes: ["deliver", "verify", "cancel"],
    signatureMode: "hmac-sha256" as const,
    consequential: true
  };
  const follow = (path: string) => ({ url: origin + path + "/{providerOperationId}" });
  return [
    {
      ...base,
      name: "stage.delivery",
      url: origin + "/deliver/delivery",
      verification: follow("/verify"),
      cancellation: follow("/cancel")
    },
    {
      ...base,
      name: "stage.duplicate",
      url: origin + "/deliver/duplicate-recovery",
      verification: follow("/verify"),
      cancellation: follow("/cancel")
    },
    {
      ...base,
      name: "stage.cancel",
      url: origin + "/deliver/cancel",
      verification: follow("/verify"),
      cancellation: follow("/cancel")
    },
    {
      ...base,
      name: "stage.tampered",
      url: origin + "/deliver/tampered-response",
      verification: follow("/verify"),
      cancellation: follow("/cancel")
    },
    {
      ...base,
      name: "stage.retry",
      url: origin + "/deliver/retry-exhaustion",
      verification: follow("/verify"),
      cancellation: follow("/cancel")
    },
    {
      ...base,
      name: "stage.restart",
      url: origin + "/deliver/restart",
      verification: follow("/verify"),
      cancellation: follow("/cancel")
    }
  ];
}

class StagingDeliveryProvider implements CredentialDeliveryProvider {
  async redeem(input: Parameters<CredentialDeliveryProvider["redeem"]>[0]) {
    return {
      material: signingSecret,
      expiresAt: input.lease.expiresAt,
      providerId: "webhook-staging",
      credentialVersion: input.lease.issuedCredentialVersion ?? 1,
      grantedScopes: ["deliver", "verify", "cancel"]
    };
  }
}

async function provisionLease(
  db: PostgresDatabase,
  request: AuthorizedBusinessActionRequest,
  now: Date
) {
  const secret = createSecretReference({
    id: "secret-" + request.id,
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    providerId: "webhook-staging",
    environment: "staging",
    purpose: "signed webhook staging acceptance",
    backendRef: "broker://webhook-staging/" + request.id,
    status: "active",
    rotationVersion: 1
  });
  const binding = createCredentialBinding({
    id: "binding-" + request.id,
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    providerId: "webhook-staging",
    environment: "staging",
    secretReferenceId: secret.id,
    capabilityNames: ["webhook.send"],
    grantedScopes: ["deliver", "verify", "cancel"],
    allowedResourceIds: [scope.resourceId],
    allowedLocationClasses: ["cloud"],
    status: "active"
  });
  const credentialRequest = createCredentialRequest({
    id: "credential-request-" + request.id,
    jobId: request.jobId,
    placementRequestId: "placement-" + request.id,
    scope,
    resourceId: scope.resourceId,
    resourceState: "ready",
    resourceLocationClass: "cloud",
    providerId: "webhook-staging",
    capability: "webhook.send",
    requestedScopes: ["deliver", "verify", "cancel"],
    requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 20 * 60_000).toISOString()
  });
  const lease = issueCredentialLease({
    leaseId: request.credentialLeaseId!,
    request: credentialRequest,
    secret,
    binding,
    deliveryRef: "delivery://webhook-staging/" + request.id,
    issuedAt: now.toISOString(),
    ttlSeconds: 600
  });
  await new PostgresCredentialBrokerStore(db).putLease(lease);
  return lease;
}

function runtime(
  db: PostgresDatabase,
  startMs: number,
  options: {
    maxStatusPolls?: number;
    maxAttempts?: number;
    pollIntervalMs?: number;
  } = {}
) {
  let clockMs = startMs;
  const now = () => new Date(clockMs);
  const queue = new PostgresDurableJobStore(db, {
    maxAttempts: options.maxAttempts ?? 3,
    recoveryDelayMs: 0
  });
  const worker = new DurableJobWorker(queue, {
    workerId: "webhook-staging-worker-" + crypto.randomUUID(),
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
  const credentialStore = new PostgresCredentialBrokerStore(db);
  const credentialBroker = new GovernedBusinessActionCredentialBroker(
    credentialStore,
    credentialStore,
    new StagingDeliveryProvider(),
    now
  );
  const adapter = new ConfiguredWebhookActionAdapter(operations(), { now });
  const business = new BusinessActionExecutionOrchestrator(
    new StaticBusinessActionAdapterRegistry([{ capability: "webhook.send", adapter }]),
    new PostgresBusinessActionExecutionStore(db),
    {
      credentialBroker,
      maxStatusPolls: options.maxStatusPolls ?? 8,
      pollIntervalMs: options.pollIntervalMs ?? 250
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
    db,
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
      if (snapshot.state === "dead-lettered") { const dead = await value.db.query<{ payload: { reason?: string } }>("SELECT payload FROM job_dead_letters WHERE job_id=$1", [jobId]); console.error("ACCEPTANCE_DEAD_LETTER", dead.rows[0]?.payload?.reason, JSON.stringify(snapshot)); }
      return snapshot;
    }
    value.advance();
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error("Webhook staging Job did not reach terminal state");
}

async function inspectRequest(requestId: string): Promise<ProviderRecord | null> {
  const response = await fetch(origin + "/inspect/request/" + encodeURIComponent(requestId), {
    headers: { authorization: "Bearer " + controlToken }
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Webhook staging inspection failed");
  const body = await response.json() as { record: ProviderRecord };
  return body.record;
}

async function assertSecretNotPersisted(db: PostgresDatabase) {
  const result = await db.query<{ payload: string }>(
    `SELECT payload::text AS payload FROM credential_leases
     UNION ALL SELECT payload::text FROM credential_usage_audits
     UNION ALL SELECT payload::text FROM job_execution_specs
     UNION ALL SELECT payload::text FROM business_action_executions`
  );
  expect(result.rows.map((row) => row.payload).join("\n")).not.toContain(signingSecret);
}

function recordCase(value: AcceptanceArtifact["cases"][number]) {
  artifact.cases.push(value);
}

liveDescribe("real signed webhook governed staging acceptance", () => {
  beforeAll(async () => {
    origin = required("GETDONE_WEBHOOK_STAGING_ORIGIN").replace(/\/$/, "");
    signingSecret = required("GETDONE_WEBHOOK_STAGING_SIGNING_SECRET");
    controlToken = required("GETDONE_WEBHOOK_STAGING_CONTROL_TOKEN");
    if (new URL(origin).protocol !== "https:") {
      throw new Error("Webhook staging origin must use real HTTPS");
    }
    artifact.endpointOriginHash = sha256Hex(origin);
    const health = await fetch(origin + "/health");
    if (!health.ok) throw new Error("Webhook staging receiver is not healthy");

    const db = database();
    try {
      await db.query(`TRUNCATE
        credential_usage_audits,
        credential_leases,
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
      "test-results/webhook-staging-acceptance.json",
      JSON.stringify({ ...artifact, generatedAt: new Date().toISOString() }, null, 2) + "\n"
    );
  });

  it("delivers a signed request, independently verifies it, and persists only credential references", async () => {
    const db = database();
    try {
      const start = Date.now();
      const value = runtime(db, start);
      const job = await seedLiveAcceptanceAuthority({ db, id: "job-webhook-" + runId + "-delivery", taskId: "task-webhook-" + runId + "-delivery", correlationId: "corr-webhook-" + runId + "-delivery", scope, capability: "webhook.send", now: new Date(start).toISOString() });
      const request = actionRequest(job, "delivery", "stage.delivery");
      
      await provisionLease(db, request, new Date(start));
      await value.mvp.enqueueAuthorizedBusinessAction(job, request);
      expect((await runUntilTerminal(value, job.id)).state).toBe("released");

      const provider = await inspectRequest(request.id);
      expect(provider).toMatchObject({
        state: "accepted",
        signatureValid: true,
        deliveryAttempts: 1,
        sideEffectCount: 1
      });
      const execution = await new PostgresBusinessActionExecutionStore(db).get(request.id);
      expect(execution?.state).toBe("completed");
      await assertSecretNotPersisted(db);
      expect((await new PostgresCredentialBrokerStore(db).listUsage(request.credentialLeaseId!)).length)
        .toBeGreaterThanOrEqual(2);

      recordCase({
        name: "signed-delivery-verification",
        outcome: "released-and-independently-verified",
        providerOperationId: execution?.providerOperationId,
        providerRecordHash: sha256Hex(provider),
        deliveryAttempts: provider?.deliveryAttempts,
        sideEffectCount: provider?.sideEffectCount
      });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("suppresses duplicate side effects after timeout-after-accept and recovers with the same idempotency lineage", async () => {
    const db = database();
    try {
      const start = Date.now();
      const value = runtime(db, start, { maxAttempts: 3 });
      const job = await seedLiveAcceptanceAuthority({ db, id: "job-webhook-" + runId + "-duplicate", taskId: "task-webhook-" + runId + "-duplicate", correlationId: "corr-webhook-" + runId + "-duplicate", scope, capability: "webhook.send", now: new Date(start).toISOString() });
      const request = actionRequest(job, "duplicate", "stage.duplicate", 250);
      
      await provisionLease(db, request, new Date(start));
      await value.mvp.enqueueAuthorizedBusinessAction(job, request);
      expect((await runUntilTerminal(value, job.id)).state).toBe("released");

      const provider = await inspectRequest(request.id);
      expect(provider).toMatchObject({
        signatureValid: true,
        sideEffectCount: 1
      });
      expect(provider!.deliveryAttempts).toBeGreaterThanOrEqual(2);
      await assertSecretNotPersisted(db);
      recordCase({
        name: "duplicate-suppression",
        outcome: "retried-with-one-provider-side-effect",
        providerRecordHash: sha256Hex(provider),
        deliveryAttempts: provider?.deliveryAttempts,
        sideEffectCount: provider?.sideEffectCount
      });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("cancels an accepted webhook through the configured cancellation endpoint", async () => {
    const db = database();
    try {
      const start = Date.now();
      const value = runtime(db, start, { maxStatusPolls: 0 });
      const job = await seedLiveAcceptanceAuthority({ db, id: "job-webhook-" + runId + "-cancel", taskId: "task-webhook-" + runId + "-cancel", correlationId: "corr-webhook-" + runId + "-cancel", scope, capability: "webhook.send", now: new Date(start).toISOString() });
      const request = actionRequest(job, "cancel", "stage.cancel");
      
      await provisionLease(db, request, new Date(start));
      await value.mvp.enqueueAuthorizedBusinessAction(job, request);
      await value.mvp.runOnce();

      const before = await new PostgresBusinessActionExecutionStore(db).get(request.id);
      expect(before?.providerOperationId).toBeTruthy();
      const cancelled = await value.business.cancel(request, "owner cancelled webhook staging action");
      expect(cancelled.record.state).toBe("cancelled");

      const provider = await inspectRequest(request.id);
      expect(provider).toMatchObject({
        state: "cancelled",
        cancellationReason: "owner cancelled webhook staging action",
        sideEffectCount: 1
      });
      recordCase({
        name: "configured-cancellation",
        outcome: "provider-cancelled",
        providerOperationId: before?.providerOperationId,
        providerRecordHash: sha256Hex(provider),
        deliveryAttempts: provider?.deliveryAttempts,
        sideEffectCount: provider?.sideEffectCount
      });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("fails closed on a tampered provider response without trusting malicious operation lineage", async () => {
    const db = database();
    try {
      const start = Date.now();
      const value = runtime(db, start, { maxAttempts: 2 });
      const job = await seedLiveAcceptanceAuthority({ db, id: "job-webhook-" + runId + "-tampered", taskId: "task-webhook-" + runId + "-tampered", correlationId: "corr-webhook-" + runId + "-tampered", scope, capability: "webhook.send", now: new Date(start).toISOString() });
      const request = actionRequest(job, "tampered", "stage.tampered");
      
      await provisionLease(db, request, new Date(start));
      await value.mvp.enqueueAuthorizedBusinessAction(job, request);
      expect((await runUntilTerminal(value, job.id)).state).toBe("dead-lettered");

      const provider = await inspectRequest(request.id);
      expect(provider).toMatchObject({ signatureValid: true, sideEffectCount: 1 });
      expect(provider!.deliveryAttempts).toBeGreaterThanOrEqual(2);
      expect(await new PostgresBusinessActionExecutionStore(db).get(request.id)).toBeNull();
      recordCase({
        name: "tampered-provider-response",
        outcome: "dead-lettered-without-malicious-lineage",
        providerRecordHash: sha256Hex(provider),
        deliveryAttempts: provider?.deliveryAttempts,
        sideEffectCount: provider?.sideEffectCount
      });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("dead-letters after retry exhaustion without creating a receiver side effect", async () => {
    const db = database();
    try {
      const start = Date.now();
      const value = runtime(db, start, { maxAttempts: 3 });
      const job = await seedLiveAcceptanceAuthority({ db, id: "job-webhook-" + runId + "-retry", taskId: "task-webhook-" + runId + "-retry", correlationId: "corr-webhook-" + runId + "-retry", scope, capability: "webhook.send", now: new Date(start).toISOString() });
      const request = actionRequest(job, "retry", "stage.retry");
      
      await provisionLease(db, request, new Date(start));
      await value.mvp.enqueueAuthorizedBusinessAction(job, request);
      expect((await runUntilTerminal(value, job.id)).state).toBe("dead-lettered");
      expect(await inspectRequest(request.id)).toBeNull();

      const execution = await new PostgresBusinessActionExecutionStore(db).get(request.id);
      expect(execution).toMatchObject({
        state: "failed",
        retryable: true,
        retryClass: "provider-5xx"
      });
      recordCase({ name: "retry-exhaustion", outcome: "dead-lettered-no-side-effect" });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("resumes verification after restart without redelivering the accepted webhook", async () => {
    const start = Date.now();
    let job!: JobRecord;
    let request!: AuthorizedBusinessActionRequest;

    const firstDb = database();
    try {
      const first = runtime(firstDb, start, { maxStatusPolls: 0 });
      job = await seedLiveAcceptanceAuthority({ db, id: "job-webhook-" + runId + "-restart", taskId: "task-webhook-" + runId + "-restart", correlationId: "corr-webhook-" + runId + "-restart", scope, capability: "webhook.send", now: new Date(start).toISOString() });
      request = actionRequest(job, "restart", "stage.restart");
      
      await provisionLease(firstDb, request, new Date(start));
      await first.mvp.enqueueAuthorizedBusinessAction(job, request);
      await first.mvp.runOnce();
      expect((await first.queue.getRuntimeSnapshot(job.id))?.state).toBe("retry-wait");
      expect((await inspectRequest(request.id))?.deliveryAttempts).toBe(1);
    } finally {
      await firstDb.close();
    }

    const secondDb = database();
    try {
      const second = runtime(secondDb, start + 5_000);
      expect((await runUntilTerminal(second, job.id)).state).toBe("released");
      const provider = await inspectRequest(request.id);
      expect(provider).toMatchObject({
        signatureValid: true,
        deliveryAttempts: 1,
        sideEffectCount: 1
      });
      const execution = await new PostgresBusinessActionExecutionStore(secondDb).get(request.id);
      expect(execution?.state).toBe("completed");
      await assertSecretNotPersisted(secondDb);

      recordCase({
        name: "restart-after-provider-acceptance",
        outcome: "resumed-verification-without-redelivery",
        providerOperationId: execution?.providerOperationId,
        providerRecordHash: sha256Hex(provider),
        deliveryAttempts: provider?.deliveryAttempts,
        sideEffectCount: provider?.sideEffectCount
      });
    } finally {
      await secondDb.close();
    }
  }, 30_000);
});
