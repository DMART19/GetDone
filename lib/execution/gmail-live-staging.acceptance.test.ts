import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import {
  GmailBusinessActionAdapter,
  gmailRfc822MessageId
} from "@/lib/execution/adapters/gmail-action";
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

const enabled = process.env.GETDONE_GMAIL_STAGING_ACCEPTANCE === "true";
const liveDescribe = enabled ? describe.sequential : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "";
const runId = (process.env.GITHUB_RUN_ID ?? crypto.randomUUID()).replace(/[^A-Za-z0-9_-]/g, "");

const scope = Object.freeze({
  userId: "owner-gmail-staging",
  portfolioId: "portfolio-gmail-staging",
  companyId: "company-gmail-staging",
  environment: "staging" as const
});

interface AcceptanceArtifact {
  runId: string;
  generatedAt: string;
  provider: "gmail";
  realProviderObjects: boolean;
  cases: Array<{
    name: string;
    outcome: string;
    providerObjectId?: string;
    providerObjectHash?: string;
    providerMessageCount?: number;
    postCalls?: number;
    faultSource?: "gmail" | "controlled-transport-fault";
  }>;
}

const artifact: AcceptanceArtifact = {
  runId,
  generatedAt: new Date().toISOString(),
  provider: "gmail",
  realProviderObjects: true,
  cases: []
};

let accessToken = "";
let recipient = "";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is required for live Gmail staging acceptance");
  return value;
}

async function mintAccessToken() {
  const body = new URLSearchParams({
    client_id: required("GETDONE_GMAIL_STAGING_CLIENT_ID"),
    client_secret: required("GETDONE_GMAIL_STAGING_CLIENT_SECRET"),
    refresh_token: required("GETDONE_GMAIL_STAGING_REFRESH_TOKEN"),
    grant_type: "refresh_token"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error("Unable to mint Gmail staging access token");
  const parsed = await response.json() as { access_token?: string };
  if (!parsed.access_token) throw new Error("Gmail token response did not contain access_token");
  return parsed.access_token;
}

function database() {
  return new PostgresDatabase({
    connectionString: databaseUrl,
    maxConnections: 6,
    ssl: process.env.GETDONE_DB_SSL !== "false"
  });
}

function job(name: string, now: string): JobRecord {
  const id = "job-gmail-" + runId + "-" + name;
  const taskId = "task-gmail-" + runId + "-" + name;
  return Object.freeze({
    id,
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    state: "queued",
    taskId,
    attempt: 0,
    maxAttempts: 5,
    authorizationGrantId: "grant-" + id,
    authorizationGrantHash: sha256Hex({ id, type: "grant" }),
    authorizationConsumption: {
      id: "consumption-" + id,
      grantId: "grant-" + id,
      grantHash: sha256Hex({ id, type: "grant" }),
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

function actionRequest(authoritative: JobRecord, name: string): AuthorizedBusinessActionRequest {
  const input = {
    companyId: scope.companyId,
    to: [recipient],
    cc: [],
    subject: "[GetDone staging " + runId + "] " + name,
    text: "GetDone governed Gmail staging acceptance. Case: " + name + ". Run: " + runId + "."
  };
  return Object.freeze({
    id: "gmail-action-" + runId + "-" + name,
    jobId: authoritative.id,
    scope,
    capability: "email.send",
    input,
    inputHash: sha256Hex(input),
    authorizationConsumptionHash: authoritative.authorizationConsumption!.consumptionHash,
    idempotencyKey: "gmail-idempotency-" + runId + "-" + name,
    timeoutMs: 30_000,
    attempt: 1
  });
}

function gmailAdapter(
  fetchImpl: typeof fetch,
  sendToken = accessToken,
  readToken = accessToken
) {
  return new GmailBusinessActionAdapter([{
    id: "gmail-live-staging",
    companyId: scope.companyId,
    environment: "staging",
    credentialRef: "env:SEND_TOKEN",
    verificationCredentialRef: "env:READ_TOKEN",
    verificationMode: "provider-object-read"
  }], {
    env: {
      SEND_TOKEN: sendToken,
      READ_TOKEN: readToken
    },
    fetchImpl
  });
}

function runtime(
  db: PostgresDatabase,
  adapter: GmailBusinessActionAdapter,
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
    workerId: "gmail-staging-worker-" + crypto.randomUUID(),
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
    new StaticBusinessActionAdapterRegistry([{ capability: "email.send", adapter }]),
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
    mvp: new MvpJobRuntime(engine, specs, handler, jobs, now),
    advance(milliseconds = 5_000) {
      clockMs += milliseconds;
    }
  };
}

async function runUntilTerminal(
  value: ReturnType<typeof runtime>,
  jobId: string,
  maxRuns = 6
) {
  for (let index = 0; index < maxRuns; index += 1) {
    await value.mvp.runOnce();
    const snapshot = await value.queue.getRuntimeSnapshot(jobId);
    if (snapshot && ["released", "dead-lettered", "cancelled"].includes(snapshot.state)) {
      return snapshot;
    }
    value.advance();
  }
  throw new Error("Gmail staging Job did not reach a terminal durable state");
}

async function independentFind(requestId: string, attempts = 12) {
  const rfc822 = gmailRfc822MessageId(requestId);
  for (let index = 0; index < attempts; index += 1) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("q", "rfc822msgid:" + rfc822);
    url.searchParams.set("maxResults", "10");
    url.searchParams.set("includeSpamTrash", "true");
    const response = await fetch(url, {
      headers: { authorization: "Bearer " + accessToken }
    });
    if (!response.ok) throw new Error("Independent Gmail search failed with " + response.status);
    const parsed = await response.json() as { messages?: Array<{ id: string }> };
    if (parsed.messages?.length) return parsed.messages;
    if (index + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return [] as Array<{ id: string }>;
}

async function independentVerify(requestId: string) {
  const messages = await independentFind(requestId);
  if (messages.length === 0) throw new Error("Independent Gmail verification found no provider object");
  const id = messages[0].id;
  const url = new URL(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + encodeURIComponent(id)
  );
  url.searchParams.set("format", "metadata");
  url.searchParams.append("metadataHeaders", "Message-ID");
  url.searchParams.append("metadataHeaders", "Subject");
  const response = await fetch(url, {
    headers: { authorization: "Bearer " + accessToken }
  });
  if (!response.ok) throw new Error("Independent Gmail object read failed with " + response.status);
  const object = await response.json() as {
    id?: string;
    threadId?: string;
    internalDate?: string;
    payload?: { headers?: Array<{ name: string; value: string }> };
  };
  if (object.id !== id) throw new Error("Independent Gmail object identity mismatch");
  const messageHeader = object.payload?.headers?.find(
    (header) => header.name.toLowerCase() === "message-id"
  )?.value;
  if (messageHeader !== "<" + gmailRfc822MessageId(requestId) + ">") {
    throw new Error("Independent Gmail Message-ID verification failed");
  }
  return {
    id,
    count: messages.length,
    hash: sha256Hex({
      id: object.id,
      threadId: object.threadId,
      internalDate: object.internalDate,
      messageHeader
    })
  };
}

async function assertNoProviderObject(requestId: string) {
  expect(await independentFind(requestId, 3)).toHaveLength(0);
}

function recordCase(input: AcceptanceArtifact["cases"][number]) {
  artifact.cases.push(input);
}

liveDescribe("real Gmail governed staging acceptance", () => {
  beforeAll(async () => {
    recipient = required("GETDONE_GMAIL_STAGING_EMAIL");
    accessToken = await mintAccessToken();
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
      "test-results/gmail-staging-acceptance.json",
      JSON.stringify({ ...artifact, generatedAt: new Date().toISOString() }, null, 2) + "\n"
    );
  });

  it("sends through the governed Job pipeline and independently verifies the Gmail object", async () => {
    const db = database();
    try {
      let postCalls = 0;
      const liveFetch: typeof fetch = async (url, init) => {
        if (init?.method === "POST" && String(url).includes("/messages/send")) postCalls += 1;
        return fetch(url, init);
      };
      const value = runtime(db, gmailAdapter(liveFetch), Date.now());
      const authoritative = job("happy", new Date().toISOString());
      const request = actionRequest(authoritative, "happy");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, request);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("released");
      const verified = await independentVerify(request.id);
      expect(verified.count).toBe(1);
      expect(postCalls).toBe(1);
      recordCase({
        name: "happy-path",
        outcome: "released-and-independently-verified",
        providerObjectId: verified.id,
        providerObjectHash: verified.hash,
        providerMessageCount: verified.count,
        postCalls,
        faultSource: "gmail"
      });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("treats duplicate idempotent enqueue as one Gmail side effect", async () => {
    const db = database();
    try {
      let postCalls = 0;
      const liveFetch: typeof fetch = async (url, init) => {
        if (init?.method === "POST" && String(url).includes("/messages/send")) postCalls += 1;
        return fetch(url, init);
      };
      const value = runtime(db, gmailAdapter(liveFetch), Date.now());
      const authoritative = job("duplicate", new Date().toISOString());
      const request = actionRequest(authoritative, "duplicate");
      await value.jobs.create(authoritative);
      const first = await value.mvp.enqueueAuthorizedBusinessAction(authoritative, request);
      const replay = await value.mvp.enqueueAuthorizedBusinessAction(authoritative, request);
      expect(replay.transaction.transactionHash).toBe(first.transaction.transactionHash);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("released");
      const verified = await independentVerify(request.id);
      expect(verified.count).toBe(1);
      expect(postCalls).toBe(1);
      recordCase({
        name: "duplicate-idempotency-key",
        outcome: "one-provider-object",
        providerObjectId: verified.id,
        providerObjectHash: verified.hash,
        providerMessageCount: verified.count,
        postCalls,
        faultSource: "gmail"
      });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("recovers timeout-after-send by Message-ID without a second POST", async () => {
    const db = database();
    try {
      let postCalls = 0;
      let injected = false;
      const faultFetch: typeof fetch = async (url, init) => {
        if (init?.method === "POST" && String(url).includes("/messages/send")) {
          postCalls += 1;
          const response = await fetch(url, init);
          await response.text();
          if (!injected) {
            injected = true;
            throw new Error("controlled timeout after real Gmail acceptance");
          }
          return response;
        }
        return fetch(url, init);
      };
      const value = runtime(db, gmailAdapter(faultFetch), Date.now());
      const authoritative = job("timeout-after-send", new Date().toISOString());
      const request = actionRequest(authoritative, "timeout-after-send");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, request);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("released");
      const verified = await independentVerify(request.id);
      expect(verified.count).toBe(1);
      expect(postCalls).toBe(1);
      recordCase({
        name: "timeout-after-send",
        outcome: "recovered-by-message-id",
        providerObjectId: verified.id,
        providerObjectHash: verified.hash,
        providerMessageCount: verified.count,
        postCalls,
        faultSource: "controlled-transport-fault"
      });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("resumes persisted provider acceptance after runtime restart without resending", async () => {
    let postCalls = 0;
    const liveFetch: typeof fetch = async (url, init) => {
      if (init?.method === "POST" && String(url).includes("/messages/send")) postCalls += 1;
      return fetch(url, init);
    };
    const firstDb = database();
    const start = Date.now();
    let authoritative: JobRecord;
    let request: AuthorizedBusinessActionRequest;
    try {
      const first = runtime(firstDb, gmailAdapter(liveFetch), start, 0);
      authoritative = job("restart-after-acceptance", new Date(start).toISOString());
      request = actionRequest(authoritative, "restart-after-acceptance");
      await first.jobs.create(authoritative);
      await first.mvp.enqueueAuthorizedBusinessAction(authoritative, request);
      await first.mvp.runOnce();
      expect((await first.queue.getRuntimeSnapshot(authoritative.id))?.state).toBe("retry-wait");
      expect(postCalls).toBe(1);
    } finally {
      await firstDb.close();
    }

    const secondDb = database();
    try {
      const resumed = runtime(secondDb, gmailAdapter(liveFetch), start + 5_000, 5);
      expect((await runUntilTerminal(resumed, authoritative!.id)).state).toBe("released");
      const verified = await independentVerify(request!.id);
      expect(verified.count).toBe(1);
      expect(postCalls).toBe(1);
      recordCase({
        name: "restart-after-acceptance",
        outcome: "resumed-provider-operation",
        providerObjectId: verified.id,
        providerObjectHash: verified.hash,
        providerMessageCount: verified.count,
        postCalls,
        faultSource: "gmail"
      });
    } finally {
      await secondDb.close();
    }
  }, 30_000);

  it("fails closed with an invalid Gmail token and creates no provider object", async () => {
    const db = database();
    try {
      const value = runtime(db, gmailAdapter(fetch, "definitely-invalid-token", accessToken), Date.now());
      const authoritative = job("invalid-token", new Date().toISOString());
      const request = actionRequest(authoritative, "invalid-token");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, request);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("dead-lettered");
      await assertNoProviderObject(request.id);
      recordCase({
        name: "invalid-token",
        outcome: "dead-lettered-no-provider-object",
        providerMessageCount: 0,
        faultSource: "gmail"
      });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("fails closed with a deliberately revoked Gmail token", async () => {
    const db = database();
    try {
      const revoked = required("GETDONE_GMAIL_STAGING_REVOKED_TOKEN");
      const value = runtime(db, gmailAdapter(fetch, revoked, accessToken), Date.now());
      const authoritative = job("revoked-token", new Date().toISOString());
      const request = actionRequest(authoritative, "revoked-token");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, request);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("dead-lettered");
      await assertNoProviderObject(request.id);
      recordCase({
        name: "revoked-token",
        outcome: "dead-lettered-no-provider-object",
        providerMessageCount: 0,
        faultSource: "gmail"
      });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("handles a controlled Gmail-shaped 429 then safely retries through the same lineage", async () => {
    const db = database();
    try {
      let injected429 = false;
      let realPostCalls = 0;
      const rateLimitedFetch: typeof fetch = async (url, init) => {
        if (init?.method === "POST" && String(url).includes("/messages/send") && !injected429) {
          injected429 = true;
          return new Response(JSON.stringify({ error: { code: 429, message: "controlled staging fault" } }), {
            status: 429,
            headers: { "content-type": "application/json" }
          });
        }
        if (init?.method === "POST" && String(url).includes("/messages/send")) realPostCalls += 1;
        return fetch(url, init);
      };
      const value = runtime(db, gmailAdapter(rateLimitedFetch), Date.now());
      const authoritative = job("rate-limit", new Date().toISOString());
      const request = actionRequest(authoritative, "rate-limit");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, request);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("released");
      const verified = await independentVerify(request.id);
      expect(verified.count).toBe(1);
      expect(realPostCalls).toBe(1);
      recordCase({
        name: "gmail-429",
        outcome: "retryable-then-released",
        providerObjectId: verified.id,
        providerObjectHash: verified.hash,
        providerMessageCount: verified.count,
        postCalls: realPostCalls,
        faultSource: "controlled-transport-fault"
      });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("recovers a malformed send response after real provider acceptance without resending", async () => {
    const db = database();
    try {
      let postCalls = 0;
      let corrupt = true;
      const malformedFetch: typeof fetch = async (url, init) => {
        if (init?.method === "POST" && String(url).includes("/messages/send")) {
          postCalls += 1;
          const response = await fetch(url, init);
          const body = await response.json() as { id?: string; threadId?: string };
          if (corrupt) {
            corrupt = false;
            return new Response(JSON.stringify({ threadId: body.threadId ?? "missing-id" }), {
              status: response.status,
              headers: { "content-type": "application/json" }
            });
          }
          return new Response(JSON.stringify(body), {
            status: response.status,
            headers: { "content-type": "application/json" }
          });
        }
        return fetch(url, init);
      };
      const value = runtime(db, gmailAdapter(malformedFetch), Date.now());
      const authoritative = job("malformed-response", new Date().toISOString());
      const request = actionRequest(authoritative, "malformed-response");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, request);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("released");
      const verified = await independentVerify(request.id);
      expect(verified.count).toBe(1);
      expect(postCalls).toBe(1);
      recordCase({
        name: "malformed-response",
        outcome: "recovered-by-message-id",
        providerObjectId: verified.id,
        providerObjectHash: verified.hash,
        providerMessageCount: verified.count,
        postCalls,
        faultSource: "controlled-transport-fault"
      });
    } finally {
      await db.close();
    }
  }, 30_000);

  it("dead-letters verification failure even though independent Gmail evidence proves the object exists", async () => {
    const db = database();
    try {
      let postAccepted = false;
      const verificationFailureFetch: typeof fetch = async (url, init) => {
        const value = new URL(String(url));
        if (init?.method === "POST" && value.pathname.endsWith("/messages/send")) {
          const response = await fetch(url, init);
          postAccepted = response.ok;
          return response;
        }
        if (
          postAccepted
          && init?.method === "GET"
          && /\/messages\/[^/]+$/.test(value.pathname)
        ) {
          return new Response(JSON.stringify({ error: { code: 403, message: "controlled verification failure" } }), {
            status: 403,
            headers: { "content-type": "application/json" }
          });
        }
        return fetch(url, init);
      };
      const value = runtime(db, gmailAdapter(verificationFailureFetch), Date.now());
      const authoritative = job("verification-failure", new Date().toISOString());
      const request = actionRequest(authoritative, "verification-failure");
      await value.jobs.create(authoritative);
      await value.mvp.enqueueAuthorizedBusinessAction(authoritative, request);
      expect((await runUntilTerminal(value, authoritative.id)).state).toBe("dead-lettered");
      const verified = await independentVerify(request.id);
      expect(verified.count).toBe(1);
      recordCase({
        name: "verification-failure",
        outcome: "dead-lettered-despite-real-provider-object",
        providerObjectId: verified.id,
        providerObjectHash: verified.hash,
        providerMessageCount: verified.count,
        faultSource: "controlled-transport-fault"
      });
    } finally {
      await db.close();
    }
  }, 30_000);
});
