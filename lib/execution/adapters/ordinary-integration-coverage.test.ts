import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { AuthorizedBusinessActionRequest, BusinessActionExecutionContext } from "@/lib/execution/adapters/business-action";
import { ConfiguredWebhookActionAdapter } from "@/lib/execution/adapters/configured-webhook-action";
import { GmailBusinessActionAdapter } from "@/lib/execution/adapters/gmail-action";
import {
  assertAdapterRequest,
  assertCredentialReference,
  assertProviderOperationId,
  classifyHttpFailure,
  interpolateOperationUrl,
  providerRequestHeaders,
  readBoundedJson,
  readBoundedResponseBody,
  resolveCredentialReference,
  type BusinessActionAdapterDeclaration
} from "@/lib/execution/adapters/ordinary-integration-framework";
import { createOrdinaryBusinessActionBindingsFromEnv } from "@/lib/execution/adapters/ordinary-integration-registry";
import { SlackBusinessActionAdapter } from "@/lib/execution/adapters/slack-action";

const baseScope = {
  userId: "owner",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production" as const
};

function request(
  capability: string,
  input: unknown,
  overrides: Partial<AuthorizedBusinessActionRequest> = {}
): AuthorizedBusinessActionRequest {
  const id = overrides.id ?? `action-${capability}`;
  return {
    id,
    jobId: overrides.jobId ?? `job-${capability}`,
    scope: overrides.scope ?? baseScope,
    capability,
    input,
    inputHash: sha256Hex(input),
    authorizationConsumptionHash: "consumption-hash",
    credentialLeaseId: "lease-1",
    idempotencyKey: "idem-1",
    timeoutMs: 5_000,
    attempt: 1,
    ...overrides
  };
}

function brokerContext(
  capability: string,
  providerId: string,
  scopes: readonly string[],
  material = "broker-token"
): BusinessActionExecutionContext {
  return {
    credential: {
      leaseId: "lease-1",
      leaseHash: sha256Hex({ capability, providerId }),
      providerId,
      capability,
      grantedScopes: [...scopes],
      material,
      issuedAt: "2026-09-22T15:59:00Z",
      expiresAt: "2099-01-01T00:00:00Z"
    }
  };
}

const declaration: BusinessActionAdapterDeclaration = {
  capability: "webhook.send",
  provider: "test-provider",
  credentialMode: "brokered-lease",
  minimumScopes: [],
  timeoutMs: { min: 100, max: 10_000 },
  idempotency: "required",
  retryTaxonomy: ["none", "transport", "timeout", "rate-limit", "provider-4xx", "provider-5xx", "malformed-response", "verification-pending"],
  providerOperationId: "required",
  statusResume: "supported",
  maxResponseBytes: 1000,
  auditEvidence: "hashed-provider-evidence",
  verificationStrategy: "configured-independent-endpoint",
  cancellation: "configured",
  tenantEnvironmentBinding: true,
  truthSemantics: "provider-acceptance-is-not-business-truth"
};

describe("ordinary integration framework coverage", () => {
  it("validates references, provider IDs, binding, timeout and server secret resolution", () => {
    expect(assertCredentialReference("env:PROVIDER_TOKEN")).toBe("env:PROVIDER_TOKEN");
    expect(() => assertCredentialReference("raw-token")).toThrow(/server-side/i);
    expect(resolveCredentialReference("env:PROVIDER_TOKEN", { PROVIDER_TOKEN: " secret " })).toBe("secret");
    expect(() => resolveCredentialReference("env:MISSING", {})).toThrow(/unavailable/i);
    expect(assertProviderOperationId(" operation-1 ")).toBe("operation-1");
    expect(() => assertProviderOperationId("\u0001")).toThrow(/malformed/i);
    expect(() => assertProviderOperationId("../../escape?target=https://attacker.invalid")).toThrow(/malformed/i);
    expect(() => assertProviderOperationId("provider/id")).toThrow(/malformed/i);

    const input = { companyId: "company-a", operation: "notify", payload: {} };
    const valid = request("webhook.send", input);
    expect(assertAdapterRequest(valid, declaration, {
      companyId: "company-a",
      environment: "production"
    })).toBe(valid);
    expect(() => assertAdapterRequest(
      request("email.send", input),
      declaration,
      { companyId: "company-a", environment: "production" }
    )).toThrow(/only accepts/i);
    expect(() => assertAdapterRequest(
      valid,
      declaration,
      { companyId: "company-b", environment: "production" }
    )).toThrow(/outside/i);
    expect(() => assertAdapterRequest(
      { ...valid, timeoutMs: 50 },
      declaration,
      { companyId: "company-a", environment: "production" }
    )).toThrow(/timeout/i);
  });

  it("bounds response bodies and parses provider JSON fail-closed", async () => {
    await expect(readBoundedResponseBody(new Response("ok"), 10)).resolves.toBe("ok");
    await expect(readBoundedResponseBody(new Response(null), 10)).resolves.toBe("");
    await expect(readBoundedResponseBody(new Response("large", {
      headers: { "content-length": "100" }
    }), 10)).rejects.toThrow(/size limit/i);
    await expect(readBoundedResponseBody(new Response("x"), 0)).rejects.toThrow(/1-5000000/i);
    await expect(readBoundedJson(new Response('{"ok":true}'), 100)).resolves.toEqual({ ok: true });
    await expect(readBoundedJson(new Response("not-json"), 100)).rejects.toThrow(/malformed JSON/i);
  });

  it("classifies HTTP failures and builds safe provider metadata", () => {
    expect(classifyHttpFailure(408)).toEqual({
      retryable: true,
      retryClass: "timeout",
      resultStatus: "failed"
    });
    expect(classifyHttpFailure(429).retryClass).toBe("rate-limit");
    expect(classifyHttpFailure(503).retryClass).toBe("provider-5xx");
    expect(classifyHttpFailure(400)).toEqual({
      retryable: false,
      retryClass: "provider-4xx",
      resultStatus: "rejected"
    });

    const req = request("webhook.send", { companyId: "company-a", operation: "notify", payload: {} });
    expect(providerRequestHeaders({
      request: req,
      credential: "secret",
      contentType: "application/json"
    })).toMatchObject({
      authorization: "Bearer secret",
      "content-type": "application/json",
      "idempotency-key": "idem-1"
    });
    expect(interpolateOperationUrl(
      "https://provider.test/operations/{providerOperationId}",
      "provider:one"
    )).toContain("provider%3Aone");
    expect(() => interpolateOperationUrl(
      "http://provider.test/{providerOperationId}",
      "op"
    )).toThrow(/credential-free HTTPS/i);
  });

  it("builds the ordinary registry from server-only configuration and fails closed empty", () => {
    const env = {
      GETDONE_HTTP_ACTIONS_JSON: JSON.stringify([{
        name: "http",
        companyId: "company-a",
        environment: "production",
        url: "https://http.example.test/action"
      }]),
      GETDONE_WEBHOOK_ACTIONS_JSON: JSON.stringify([{
        name: "hook",
        companyId: "company-a",
        environment: "production",
        url: "https://hook.example.test/action"
      }]),
      GETDONE_GMAIL_ACTIONS_JSON: JSON.stringify([{
        id: "gmail",
        companyId: "company-a",
        environment: "production",
        credentialProviderId: "gmail-provider"
      }]),
      GETDONE_SLACK_ACTIONS_JSON: JSON.stringify([{
        id: "slack",
        companyId: "company-a",
        environment: "production",
        credentialProviderId: "slack-provider"
      }]),
      GETDONE_GITHUB_ACTIONS_JSON: JSON.stringify([{
        id: "github",
        companyId: "company-a",
        environment: "production",
        credentialProviderId: "github-provider",
        repositories: ["DMART19/GetDone"],
        protectedBranches: ["main"]
      }]),
      GETDONE_ANALYTICS_SOURCES_JSON: JSON.stringify([{
        id: "analytics",
        companyId: "company-a",
        environment: "production",
        credentialProviderId: "analytics-provider",
        url: "https://analytics.example.test/events",
        schema: {
          fields: { id: "string", updatedAt: "datetime" },
          required: ["id", "updatedAt"]
        }
      }]),
      GETDONE_CALENDAR_ACTIONS_JSON: JSON.stringify([{
        id: "calendar",
        companyId: "company-a",
        environment: "production",
        credentialProviderId: "calendar-provider",
        baseUrl: "https://calendar.example.test/v1/",
        calendarPath: "calendars/{calendarId}/events",
        eventPath: "calendars/{calendarId}/events/{eventId}",
        conflictCheckPath: "calendars/{calendarId}/conflicts"
      }])
    };
    const analyticsStore = {
      getCheckpoint: async () => null,
      getRun: async () => null,
      commitPage: async () => { throw new Error("not used"); }
    };
    expect(createOrdinaryBusinessActionBindingsFromEnv(env, { analyticsStore }).map((item) => item.capability))
      .toEqual([
        "http.request",
        "webhook.send",
        "email.send",
        "slack.message.send",
        "github.repository.read",
        "github.branch.create",
        "github.commit.create",
        "github.protected-branch.commit",
        "github.pull-request.write",
        "github.issue.write",
        "github.pull-request.merge",
        "analytics.ingest.read",
        "calendar.event.read",
        "calendar.event.create",
        "calendar.event.update",
        "calendar.event.cancel"
      ]);
    expect(() => createOrdinaryBusinessActionBindingsFromEnv({
      GETDONE_ANALYTICS_SOURCES_JSON: env.GETDONE_ANALYTICS_SOURCES_JSON
    })).toThrow(/durable evidence\/checkpoint persistence/i);
    expect(() => createOrdinaryBusinessActionBindingsFromEnv({})).toThrow(/At least one/i);
  });
});

describe("ordinary provider lifecycle coverage", () => {
  it("executes and verifies Gmail with multipart MIME and separate read credential", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GmailBusinessActionAdapter([{
      id: "gmail-primary",
      companyId: "company-a",
      environment: "production",
      credentialProviderId: "gmail-provider",
      baseUrl: "https://gmail.example.test/gmail/v1/",
      userId: "me",
      verificationMode: "provider-object-read"
    }], {
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return init?.method === "POST"
          ? new Response('{"id":"message-1","threadId":"thread-1"}', { status: 200 })
          : new Response('{"id":"message-1"}', { status: 200 });
      },
      now: () => new Date("2026-09-22T16:00:00Z")
    });
    const input = {
      companyId: "company-a",
      to: ["to@example.com"],
      cc: ["cc@example.com"],
      subject: "Hello ✓",
      text: "plain",
      html: "<p>html</p>",
      replyTo: "reply@example.com"
    };
    const gmailAction = request("email.send", input);
    const gmailContext = brokerContext("email.send", "gmail-provider", [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly"
    ]);
    const accepted = await adapter.execute(gmailAction, gmailContext);
    expect(accepted).toMatchObject({
      status: "accepted",
      providerOperationId: "gmail:gmail-primary:message-1",
      output: {
        messageId: "message-1",
        accepted: ["to@example.com", "cc@example.com"]
      }
    });
    expect(calls[0].init?.method).toBe("GET");
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer broker-token");
    const sendCall = calls.find((call) => call.init?.method === "POST");
    expect(sendCall).toBeDefined();
    const sendHeaders = sendCall!.init?.headers as Record<string, string>;
    expect(sendHeaders.authorization).toBe("Bearer broker-token");
    const sendBody = JSON.parse(String(sendCall!.init?.body)) as { raw: string };
    const mime = Buffer.from(sendBody.raw, "base64url").toString("utf8");
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain("Reply-To: reply@example.com");
    expect(mime).toContain("Message-ID: <getdone-");

    const status = await adapter.status({
      requestId: accepted.requestId,
      providerOperationId: accepted.providerOperationId!
    }, gmailContext);
    expect(status.state).toBe("completed");
    expect((calls.at(-1)?.init?.headers as Record<string, string>).authorization).toBe("Bearer broker-token");
  });

  it("covers Gmail transport, provider failure, status retry, validation and env parsing", async () => {
    const config = {
      id: "gmail-dev",
      companyId: "company-a",
      environment: "development" as const,
      credentialProviderId: "gmail-dev-provider",
      baseUrl: "https://gmail.example.test/",
      verificationMode: "provider-acceptance-only" as const
    };
    const input = {
      companyId: "company-a",
      to: ["to@example.com"],
      cc: [],
      subject: "subject",
      text: "body"
    };
    const transport = new GmailBusinessActionAdapter([config], {
      fetchImpl: async () => { throw new Error("network"); }
    });
    const gmailDevAction = request("email.send", input, {
      scope: { ...baseScope, environment: "development" }
    });
    const gmailDevContext = brokerContext(
      "email.send",
      "gmail-dev-provider",
      ["https://www.googleapis.com/auth/gmail.send"]
    );
    await expect(transport.execute(gmailDevAction, gmailDevContext))
      .resolves.toMatchObject({ status: "failed", retryClass: "transport" });

    const rateLimited = new GmailBusinessActionAdapter([config], {
      fetchImpl: async () => new Response('{"error":"rate"}', { status: 429 })
    });
    await expect(rateLimited.execute(gmailDevAction, gmailDevContext))
      .resolves.toMatchObject({ status: "failed", retryClass: "rate-limit" });

    expect(() => new GmailBusinessActionAdapter([{
      ...config,
      environment: "production",
      verificationMode: "provider-acceptance-only"
    }])).toThrow(/provider-object verification/i);
    expect(() => new GmailBusinessActionAdapter([])).toThrow(/non-empty/i);
    expect(() => new GmailBusinessActionAdapter([config, config])).toThrow(/unique/i);
  });

  it("executes, verifies and cancels Slack using one provider operation lineage", async () => {
    const calls: string[] = [];
    const adapter = new SlackBusinessActionAdapter([{
      id: "slack-primary",
      companyId: "company-a",
      environment: "production",
      credentialProviderId: "slack-provider",
      baseUrl: "https://slack.example.test/api/",
      verificationMode: "provider-object-read"
    }], {
      fetchImpl: async (url, init) => {
        const target = String(url);
        calls.push(`${init?.method ?? "GET"} ${target}`);
        if (target.includes("chat.postMessage")) {
          const body = JSON.parse(String(init?.body));
          expect(body.client_msg_id).toMatch(/^[a-f0-9-]{36}$/);
          return new Response('{"ok":true,"channel":"C123","ts":"1720000000.123456"}', { status: 200 });
        }
        if (target.includes("conversations.history")) {
          return new Response('{"ok":true,"messages":[{"ts":"1720000000.123456"}]}', { status: 200 });
        }
        return new Response('{"ok":true}', { status: 200 });
      },
      now: () => new Date("2026-09-22T16:00:00Z")
    });
    const input = {
      companyId: "company-a",
      channelId: "C123",
      text: "hello",
      threadTs: "1719999999.123456"
    };
    const slackAction = request("slack.message.send", input);
    const slackContext = brokerContext(
      "slack.message.send",
      "slack-provider",
      ["chat:write", "channels:history"]
    );
    const accepted = await adapter.execute(slackAction, slackContext);
    expect(accepted).toMatchObject({
      status: "accepted",
      providerOperationId: "slack:slack-primary:C123:1720000000.123456"
    });
    await expect(adapter.status({
      requestId: accepted.requestId,
      providerOperationId: accepted.providerOperationId!
    }, slackContext)).resolves.toMatchObject({ state: "completed" });
    await expect(adapter.cancel({
      requestId: accepted.requestId,
      providerOperationId: accepted.providerOperationId!,
      reason: "operator rollback"
    }, slackContext)).resolves.toMatchObject({ state: "cancelled" });
    expect(calls).toHaveLength(3);
  });

  it("covers Slack provider errors, retry status, cancellation failure and validation", async () => {
    const config = {
      id: "slack-dev",
      companyId: "company-a",
      environment: "development" as const,
      credentialProviderId: "slack-dev-provider",
      baseUrl: "https://slack.example.test/api/",
      verificationMode: "provider-object-read" as const
    };
    const input = { companyId: "company-a", channelId: "C1", text: "hello" };
    const providerError = new SlackBusinessActionAdapter([config], {
      fetchImpl: async () => new Response('{"ok":false,"error":"ratelimited"}', { status: 200 })
    });
    const slackDevAction = request("slack.message.send", input, {
      scope: { ...baseScope, environment: "development" }
    });
    const slackDevContext = brokerContext(
      "slack.message.send",
      "slack-dev-provider",
      ["chat:write", "channels:history"]
    );
    await expect(providerError.execute(slackDevAction, slackDevContext))
      .resolves.toMatchObject({ status: "failed", retryable: true });

    const retryStatus = new SlackBusinessActionAdapter([config], {
      fetchImpl: async () => new Response('{"error":"down"}', { status: 503 })
    });
    await expect(retryStatus.status({
      requestId: "action",
      providerOperationId: "slack:slack-dev:C1:1720000000.123456"
    }, slackDevContext)).resolves.toMatchObject({ state: "running" });
    await expect(retryStatus.cancel({
      requestId: "action",
      providerOperationId: "slack:slack-dev:C1:1720000000.123456",
      reason: "stop"
    }, slackDevContext)).resolves.toMatchObject({ state: "running" });
    await expect(retryStatus.cancel({
      requestId: "action",
      providerOperationId: "slack:slack-dev:C1:1720000000.123456",
      reason: " "
    }, slackDevContext)).rejects.toThrow(/reason is required/i);

    expect(() => new SlackBusinessActionAdapter([{
      ...config,
      environment: "production",
      verificationMode: "provider-acceptance-only"
    }])).toThrow(/provider-object verification/i);
  });

  it("covers webhook rejection, transport, polling and cancellation outcomes", async () => {
    const operation = {
      name: "notify",
      companyId: "company-a",
      environment: "production" as const,
      url: "https://hooks.example.test/send",
      credentialProviderId: "webhook-provider",
      consequential: true,
      verification: { url: "https://hooks.example.test/status/{providerOperationId}" },
      cancellation: { url: "https://hooks.example.test/cancel/{providerOperationId}" }
    };
    const input = { companyId: "company-a", operation: "notify", payload: { id: "1" } };

    const transport = new ConfiguredWebhookActionAdapter([operation], {
      fetchImpl: async () => { throw new Error("network"); }
    });
    const webhookAction = request("webhook.send", input);
    const webhookContext = brokerContext("webhook.send", "webhook-provider", []);
    await expect(transport.execute(webhookAction, webhookContext)).resolves.toMatchObject({
      status: "failed",
      retryClass: "transport"
    });

    let mode: "send" | "status" | "cancel" = "send";
    const adapter = new ConfiguredWebhookActionAdapter([operation], {
      fetchImpl: async () => {
        if (mode === "send") return new Response("rate", { status: 429 });
        if (mode === "status") return new Response("pending", { status: 503 });
        return new Response("cancelled", { status: 200 });
      }
    });
    await expect(adapter.execute(webhookAction, webhookContext)).resolves.toMatchObject({
      status: "failed",
      retryClass: "rate-limit"
    });
    mode = "status";
    await expect(adapter.status({
      requestId: "action",
      providerOperationId: "webhook:notify:provider-1"
    }, webhookContext)).resolves.toMatchObject({ state: "running" });
    mode = "cancel";
    await expect(adapter.cancel({
      requestId: "action",
      providerOperationId: "webhook:notify:provider-1",
      reason: "stop"
    }, webhookContext)).resolves.toMatchObject({ state: "cancelled" });

    expect(() => new ConfiguredWebhookActionAdapter([{
      ...operation,
      verification: undefined
    }])).toThrow(/independent verification/i);
  });
});
