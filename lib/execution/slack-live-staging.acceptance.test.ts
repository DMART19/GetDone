import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import {
  SlackBusinessActionAdapter,
  deterministicSlackClientMessageId
} from "@/lib/execution/adapters/slack-action";
import { StaticBusinessActionAdapterRegistry } from "@/lib/execution/adapters/business-action-registry";
import { BusinessActionExecutionOrchestrator } from "@/lib/execution/business-action-orchestrator";
import { DurableJobEngine } from "@/lib/execution/durable-job-engine";
import { RoutedJobExecutionHandler } from "@/lib/execution/job-execution-router";
import { DurableJobWorker } from "@/lib/execution/job-worker-runtime";
import { MvpJobRuntime } from "@/lib/execution/mvp-job-runtime.server";
import { PostgresEntityStore } from "@/lib/persistence/postgres/authority-stores";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresBusinessActionExecutionStore } from "@/lib/persistence/postgres/execution-stores";
import { PostgresJobExecutionSpecStore } from "@/lib/persistence/postgres/job-execution-spec-store";
import { PostgresDurableJobStore } from "@/lib/persistence/postgres/job-store";
import { PostgresJobVerificationEvidenceStore } from "@/lib/persistence/postgres/worker-runtime-stores";

const enabled = process.env.GETDONE_SLACK_STAGING_ACCEPTANCE === "true";
const liveDescribe = enabled ? describe.sequential : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "";
const runId = (process.env.GITHUB_RUN_ID ?? crypto.randomUUID()).replace(/[^A-Za-z0-9_-]/g, "");

const scope = Object.freeze({
  userId: "owner-slack-staging",
  portfolioId: "portfolio-slack-staging",
  companyId: "company-slack-staging",
  environment: "staging" as const
});

interface AcceptanceArtifact {
  runId: string;
  generatedAt: string;
  provider: "slack";
  realProviderObjects: boolean;
  cases: Array<{
    name: string;
    outcome: string;
    providerOperationId?: string;
    providerObjectHash?: string;
    postCalls?: number;
    faultSource?: "slack" | "controlled-transport-fault";
  }>;
}

const artifact: AcceptanceArtifact = {
  runId,
  generatedAt: new Date().toISOString(),
  provider: "slack",
  realProviderObjects: true,
  cases: []
};

let botToken = "";
let readToken = "";
let noWriteToken = "";
let revokedToken = "";
let channelId = "";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is required for live Slack staging acceptance");
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
  const id = "job-slack-" + runId + "-" + name;
  const taskId = "task-slack-" + runId + "-" + name;
  const grantHash = sha256Hex({ id, type: "grant" });
  return Object.freeze({
    id,
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

function request(authoritative: JobRecord, name: string, targetChannel = channelId): AuthorizedBusinessActionRequest {
  const input = {
    companyId: scope.companyId,
    channelId: targetChannel,
    text: "[GetDone staging " + runId + "] " + name
  };
  return Object.freeze({
    id: "slack-action-" + runId + "-" + name,
    jobId: authoritative.id,
    scope,
    capability: "slack.message.send",
    input,
    inputHash: sha256Hex(input),
    authorizationConsumptionHash: authoritative.authorizationConsumption!.consumptionHash,
    idempotencyKey: "slack-idempotency-" + runId + "-" + name,
    timeoutMs: 30_000,
    attempt: 1
  });
}

function adapter(
  fetchImpl: typeof fetch,
  sendCredential = botToken,
  verificationCredential = readToken
) {
  return new SlackBusinessActionAdapter([{
    id: "slack-live-staging",
    companyId: scope.companyId,
    environment: "staging",
    credentialRef: "env:SEND_TOKEN",
    verificationCredentialRef: "env:READ_TOKEN",
    verificationMode: "provider-object-read"
  }], {
    env: {
      SEND_TOKEN: sendCredential,
      READ_TOKEN: verificationCredential
    },
    fetchImpl
  });
}

function runtime(
  db: PostgresDatabase,
  slack: SlackBusinessActionAdapter,
  startMs: number,
  maxStatusPolls = 5
) {
  let clockMs = startMs;
  const now = () => new Date(clockMs);
  const queue = new PostgresDurableJobStore(db, {
    maxAttempts: 5,
    recoveryDelayMs: 0
  });
  const worker = new DurableJobWorker(queue, {
    workerId: "slack-staging-worker-" + crypto.randomUUID(),
    leaseSeconds: 30,
    heartbeatSeconds: 5,
    batchSize: 4,
    concurrency: 1,
    retryBaseDelayMs: 0,
    maxAttempts: 5
  }, now);
  const engine = new DurableJobEngine(queue, worker);
  const specs = new PostgresJobExecutionSpecStore(db);
  const jobs = new PostgresEntityStore<JobRecord>(db, "job");
  const business = new BusinessActionExecutionOrchestrator(
    new StaticBusinessActionAdapterRegistry([{ capability: "slack.message.send", adapter: slack }]),
    new PostgresBusinessActionExecutionStore(db),
    { maxStatusPolls, pollIntervalMs: 500 }
  );
  const handler = new RoutedJobExecutionHandler(
    specs,
    business,
    undefined,
    {
      jobs,
      verificationEvidence: new PostgresJobVerificationEvidenceStore(db)
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

async function runUntilTerminal(value: ReturnType<typeof runtime>, jobId: string, maxRuns = 6) {
  for (let index = 0; index < maxRuns; index += 1) {
    await value.mvp.runOnce();
    const snapshot = await value.queue.getRuntimeSnapshot(jobId);
    if (snapshot && ["released", "dead-lettered", "cancelled"].includes(snapshot.state)) {
      return snapshot;
    }
    value.advance();
  }
  throw new Error("Slack staging Job did not reach a terminal durable state");
}

function parseOperationId(value: string) {
  const match = /^slack:slack-live-staging:([^:]+):(\d+\.\d+)$/.exec(value);
  if (!match) throw new Error("Unexpected Slack provider operation id: " + value);
  return { channel: match[1], ts: match[2] };
}

async function slackApi(method: string, token: string, init: RequestInit = {}) {
  const response = await fetch("https://slack.com/api/" + method, {
    ...init,
    headers: {
      authorization: "Bearer " + token,
      ...(init.headers ?? {})
    }
  });
  const body = await response.json() as Record<string, unknown>;
  return { response, body };
}

async function independentVerify(providerOperationId: string, expectedText: string) {
  const parsed = parseOperationId(providerOperationId);
  const url = new URL("https://slack.com/api/conversations.history");
  url.searchParams.set("channel", parsed.channel);
  url.searchParams.set("latest", parsed.ts);
  url.searchParams.set("inclusive", "true");
  url.searchParams.set("limit", "1");
  const { response, body } = await slackApi(url.pathname.replace("/api/", "") + url.search, readToken);
  if (!response.ok || body.ok !== true) {
    throw new Error("Independent Slack verification failed: " + JSON.stringify(body));
  }
  const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : [];
  const message = messages.find((item) => item.ts === parsed.ts);
  if (!message || message.text !== expectedText) {
    throw new Error("Independent Slack object identity/content verification failed");
  }
  return sha256Hex({
    channel: parsed.channel,
    ts: parsed.ts,
    text: message.text,
    clientMsgId: message.client_msg_id ?? null
  });
}

async function independentAbsent(providerOperationId: string) {
  const parsed = parseOperationId(providerOperationId);
  const url = new URL("https://slack.com/api/conversations.history");
  url.searchParams.set("channel", parsed.channel);
  url.searchParams.set("latest", parsed.ts);
  url.searchParams.set("inclusive", "true");
  url.searchParams.set("limit", "1");
  const { body } = await slackApi(url.pathname.replace("/api/", "") + url.search, readToken);
  if (body.ok !== true) throw new Error("Independent Slack absence check failed");
  const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : [];
  return !messages.some((item) => item.ts === parsed.ts);
}

function recordCase(value: AcceptanceArtifact["cases"][number]) {
  artifact.cases.push(value);
}

liveDescribe("real Slack governed staging acceptance", () => {
  beforeAll(async () => {
    botToken = required("GETDONE_SLACK_STAGING_BOT_TOKEN");
    readToken = process.env.GETDONE_SLACK_STAGING_READ_TOKEN?.trim() || botToken;
    noWriteToken = required("GETDONE_SLACK_STAGING_NO_WRITE_TOKEN");
    revokedToken = required("GETDONE_SLACK_STAGING_REVOKED_TOKEN");
    channelId = required("GETDONE_SLACK_STAGING_CHANNEL_ID");

    const auth = await slackApi("auth.test", botToken);
    if (!auth.response.ok || auth.body.ok !== true) {
      throw new Error("Slack staging bot token failed auth.test");
    }
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
      "test-results/slack-staging-acceptance.json",
      JSON.stringify({ ...artifact, generatedAt: new Date().toISOString() }, null, 2) + "\n"
    );
  });

  it("posts through the governed Job pipeline, verifies the provider object, and uses deterministic client_msg_id", async () => {
    const db = database();
    try {
      let postCalls = 0;
      let observedClientMsgId = "";
      const liveFetch: typeof fetch = async (url, init) => {
        if (String(url).endsWith("/chat.postMessage") && init?.method === "POST") {
          postCalls += 1;
          const parsed = JSON.parse(String(init.body)) as { client_msg_id?: string };
          observedClientMsgId = parsed.client_msg_id ?? "";
        }
        return fetch(url, init);
      };
      const value = runtime(db, adapter(liveFetch), Date.now());
      const authoritative = job("happy", new Date().toISOString());
      const action = request(authoritative, "happy");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, action);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("released");

      const record = await new PostgresBusinessActionExecutionStore(db).get(action.id);
      expect(record?.providerOperationId).toBeTruthy();
      const hash = await independentVerify(record!.providerOperationId!, (action.input as { text: string }).text);
      expect(observedClientMsgId).toBe(deterministicSlackClientMessageId(action.idempotencyKey));
      expect(postCalls).toBe(1);
      recordCase({
        name: "chat.postMessage-provider-verification-client_msg_id",
        outcome: "released-and-independently-verified",
        providerOperationId: record!.providerOperationId,
        providerObjectHash: hash,
        postCalls,
        faultSource: "slack"
      });
    } finally {
      await db.close();
    }
  }, 60_000);

  it("cancels an accepted Slack message through chat.delete and independently confirms deletion", async () => {
    const db = database();
    try {
      const value = runtime(db, adapter(fetch), Date.now(), 0);
      const authoritative = job("cancel", new Date().toISOString());
      const action = request(authoritative, "cancel");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, action);
      await value.mvp.runOnce();

      const before = await new PostgresBusinessActionExecutionStore(db).get(action.id);
      expect(before?.providerOperationId).toBeTruthy();
      const cancelled = await value.business.cancel(action, "Slack staging cancellation acceptance");
      expect(cancelled.record.state).toBe("cancelled");

      let absent = false;
      for (let index = 0; index < 6; index += 1) {
        absent = await independentAbsent(before!.providerOperationId!);
        if (absent) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(absent).toBe(true);
      recordCase({
        name: "chat.delete-cancellation",
        outcome: "cancelled-and-independently-absent",
        providerOperationId: before!.providerOperationId,
        faultSource: "slack"
      });
    } finally {
      await db.close();
    }
  }, 60_000);

  it("retries a controlled HTTP 429 and creates only one real Slack provider object", async () => {
    const db = database();
    try {
      let injected = false;
      let realPostCalls = 0;
      const rateLimitedFetch: typeof fetch = async (url, init) => {
        if (String(url).endsWith("/chat.postMessage") && init?.method === "POST" && !injected) {
          injected = true;
          return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "1" }
          });
        }
        if (String(url).endsWith("/chat.postMessage") && init?.method === "POST") realPostCalls += 1;
        return fetch(url, init);
      };
      const value = runtime(db, adapter(rateLimitedFetch), Date.now());
      const authoritative = job("rate-limit", new Date().toISOString());
      const action = request(authoritative, "rate-limit");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, action);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("released");
      const record = await new PostgresBusinessActionExecutionStore(db).get(action.id);
      const hash = await independentVerify(record!.providerOperationId!, (action.input as { text: string }).text);
      expect(realPostCalls).toBe(1);
      recordCase({
        name: "rate-limit-retry",
        outcome: "retryable-then-released",
        providerOperationId: record!.providerOperationId,
        providerObjectHash: hash,
        postCalls: realPostCalls,
        faultSource: "controlled-transport-fault"
      });
    } finally {
      await db.close();
    }
  }, 60_000);

  it("fails closed for a revoked token", async () => {
    const db = database();
    try {
      const value = runtime(db, adapter(fetch, revokedToken, readToken), Date.now());
      const authoritative = job("revoked-token", new Date().toISOString());
      const action = request(authoritative, "revoked-token");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, action);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("dead-lettered");
      expect((await new PostgresBusinessActionExecutionStore(db).get(action.id))?.providerOperationId)
        .toBeUndefined();
      recordCase({ name: "token-revocation", outcome: "dead-lettered-no-provider-object", faultSource: "slack" });
    } finally {
      await db.close();
    }
  }, 60_000);

  it("fails closed for a valid Slack token without chat:write permission", async () => {
    const db = database();
    try {
      const value = runtime(db, adapter(fetch, noWriteToken, readToken), Date.now());
      const authoritative = job("permission-failure", new Date().toISOString());
      const action = request(authoritative, "permission-failure");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, action);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("dead-lettered");
      const record = await new PostgresBusinessActionExecutionStore(db).get(action.id);
      expect(record?.state).toBe("rejected");
      recordCase({ name: "permission-failure", outcome: "provider-rejected", faultSource: "slack" });
    } finally {
      await db.close();
    }
  }, 60_000);

  it("fails closed for channel-not-found with the real staging token", async () => {
    const db = database();
    try {
      const value = runtime(db, adapter(fetch), Date.now());
      const authoritative = job("channel-not-found", new Date().toISOString());
      const action = request(authoritative, "channel-not-found", "C0000000000");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, action);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("dead-lettered");
      const record = await new PostgresBusinessActionExecutionStore(db).get(action.id);
      expect(record?.state).toBe("rejected");
      recordCase({ name: "channel-not-found", outcome: "provider-rejected", faultSource: "slack" });
    } finally {
      await db.close();
    }
  }, 60_000);

  it("resumes provider acceptance after process restart without reposting", async () => {
    let postCalls = 0;
    const liveFetch: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/chat.postMessage") && init?.method === "POST") postCalls += 1;
      return fetch(url, init);
    };
    const start = Date.now();
    let authoritative!: JobRecord;
    let action!: AuthorizedBusinessActionRequest;

    const firstDb = database();
    try {
      const first = runtime(firstDb, adapter(liveFetch), start, 0);
      authoritative = job("restart-resume", new Date(start).toISOString());
      action = request(authoritative, "restart-resume");
      await first.jobs.create(authoritative);
      await first.mvp.enqueueAuthorizedBusinessAction(authoritative, action);
      await first.mvp.runOnce();
      expect((await first.queue.getRuntimeSnapshot(authoritative.id))?.state).toBe("retry-wait");
      expect(postCalls).toBe(1);
    } finally {
      await firstDb.close();
    }

    const secondDb = database();
    try {
      const resumed = runtime(secondDb, adapter(liveFetch), start + 5_000, 5);
      expect((await runUntilTerminal(resumed, authoritative.id)).state).toBe("released");
      const record = await new PostgresBusinessActionExecutionStore(secondDb).get(action.id);
      const hash = await independentVerify(record!.providerOperationId!, (action.input as { text: string }).text);
      expect(postCalls).toBe(1);
      recordCase({
        name: "restart-resume",
        outcome: "resumed-provider-operation-without-repost",
        providerOperationId: record!.providerOperationId,
        providerObjectHash: hash,
        postCalls,
        faultSource: "slack"
      });
    } finally {
      await secondDb.close();
    }
  }, 60_000);
});
