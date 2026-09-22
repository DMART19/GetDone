import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import { ConfiguredHttpActionAdapter } from "@/lib/execution/adapters/configured-http-action";
import { ConfiguredWebhookActionAdapter } from "@/lib/execution/adapters/configured-webhook-action";
import { GmailBusinessActionAdapter } from "@/lib/execution/adapters/gmail-action";
import { SlackBusinessActionAdapter } from "@/lib/execution/adapters/slack-action";

const scope = {
  userId: "owner",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production" as const
};

function request(
  capability: string,
  input: unknown,
  id = `action-${capability}`
): AuthorizedBusinessActionRequest {
  return {
    id,
    jobId: `job-${capability}`,
    scope,
    capability,
    input,
    inputHash: sha256Hex(input),
    authorizationConsumptionHash: `consumption-${capability}`,
    credentialLeaseId: `lease-${capability}`,
    idempotencyKey: `idempotency-${capability}`,
    timeoutMs: 5_000,
    attempt: 1
  };
}

describe("ordinary integration adapters", () => {
  it("declares the governed controls required by every ordinary adapter", () => {
    const http = new ConfiguredHttpActionAdapter([{
      name: "crm.contact.sync",
      companyId: "company-a",
      environment: "production",
      url: "https://api.example.test/sync",
      credentialRef: "env:HTTP_TOKEN"
    }], { env: { HTTP_TOKEN: "secret" } });
    const webhook = new ConfiguredWebhookActionAdapter([{
      name: "billing.notify",
      companyId: "company-a",
      environment: "production",
      url: "https://hooks.example.test/notify",
      credentialRef: "env:WEBHOOK_TOKEN"
    }], { env: { WEBHOOK_TOKEN: "secret" } });
    const gmail = new GmailBusinessActionAdapter([{
      id: "gmail-primary",
      companyId: "company-a",
      environment: "production",
      credentialRef: "env:GMAIL_TOKEN",
      verificationMode: "provider-object-read"
    }], { env: { GMAIL_TOKEN: "secret" } });
    const slack = new SlackBusinessActionAdapter([{
      id: "slack-primary",
      companyId: "company-a",
      environment: "production",
      credentialRef: "env:SLACK_TOKEN",
      verificationMode: "provider-object-read"
    }], { env: { SLACK_TOKEN: "secret" } });

    for (const adapter of [http, webhook, gmail, slack]) {
      expect(adapter.declaration).toMatchObject({
        credentialMode: "credential-reference",
        idempotency: "required",
        providerOperationId: "required",
        auditEvidence: "hashed-provider-evidence",
        tenantEnvironmentBinding: true,
        truthSemantics: "provider-acceptance-is-not-business-truth"
      });
      expect(adapter.declaration.retryTaxonomy).toContain("rate-limit");
      expect(adapter.declaration.maxResponseBytes).toBeGreaterThan(0);
    }
  });

  it("keeps a consequential webhook at provider-accepted until configured verification passes", async () => {
    const calls: string[] = [];
    const adapter = new ConfiguredWebhookActionAdapter([{
      name: "billing.notify",
      companyId: "company-a",
      environment: "production",
      url: "https://hooks.example.test/notify",
      credentialRef: "env:WEBHOOK_TOKEN",
      consequential: true,
      verification: {
        url: "https://hooks.example.test/status/{providerOperationId}",
        credentialRef: "env:WEBHOOK_VERIFY_TOKEN"
      }
    }], {
      env: {
        WEBHOOK_TOKEN: "send-secret",
        WEBHOOK_VERIFY_TOKEN: "verify-secret"
      },
      fetchImpl: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(url)}`);
        if (init?.method === "POST") {
          return new Response('{"accepted":true}', {
            status: 202,
            headers: { "x-provider-operation-id": "provider-123" }
          });
        }
        return new Response('{"verified":true}', { status: 200 });
      },
      now: () => new Date("2026-09-22T16:00:00Z")
    });
    const input = {
      companyId: "company-a",
      operation: "billing.notify",
      payload: { invoiceId: "inv-1" }
    };
    const accepted = await adapter.execute(request("webhook.send", input));
    expect(accepted.status).toBe("accepted");
    expect(accepted.providerOperationId).toBe("webhook:billing.notify:provider-123");
    const verified = await adapter.status({
      requestId: accepted.requestId,
      providerOperationId: accepted.providerOperationId!
    });
    expect(verified.state).toBe("completed");
    expect(calls).toHaveLength(2);
  });

  it("fails closed on malformed Gmail and Slack provider responses", async () => {
    const gmail = new GmailBusinessActionAdapter([{
      id: "gmail-primary",
      companyId: "company-a",
      environment: "production",
      credentialRef: "env:GMAIL_TOKEN",
      verificationMode: "provider-object-read",
      baseUrl: "https://gmail.example.test/"
    }], {
      env: { GMAIL_TOKEN: "secret" },
      fetchImpl: async () => new Response('{"threadId":"missing-id"}', { status: 200 }),
      now: () => new Date("2026-09-22T16:00:00Z")
    });
    const emailInput = {
      companyId: "company-a",
      to: ["owner@example.com"],
      cc: [],
      subject: "Test",
      text: "hello"
    };
    await expect(gmail.execute(request("email.send", emailInput))).resolves.toMatchObject({
      status: "failed",
      retryable: false,
      retryClass: "malformed-response"
    });

    const slack = new SlackBusinessActionAdapter([{
      id: "slack-primary",
      companyId: "company-a",
      environment: "production",
      credentialRef: "env:SLACK_TOKEN",
      verificationMode: "provider-object-read",
      baseUrl: "https://slack.example.test/api/"
    }], {
      env: { SLACK_TOKEN: "secret" },
      fetchImpl: async () => new Response('{"ok":true,"channel":"C123"}', { status: 200 }),
      now: () => new Date("2026-09-22T16:00:00Z")
    });
    const slackInput = {
      companyId: "company-a",
      channelId: "C123",
      text: "hello"
    };
    await expect(slack.execute(request("slack.message.send", slackInput))).resolves.toMatchObject({
      status: "failed",
      retryable: false,
      retryClass: "malformed-response"
    });
  });

  it("stream-limits hostile webhook responses and rejects raw secret configuration", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123456789"));
        controller.close();
      }
    });
    const adapter = new ConfiguredWebhookActionAdapter([{
      name: "small",
      companyId: "company-a",
      environment: "production",
      url: "https://hooks.example.test/small",
      maxResponseBytes: 4
    }], {
      fetchImpl: async () => new Response(body, { status: 200 })
    });
    const input = { companyId: "company-a", operation: "small", payload: {} };
    await expect(adapter.execute(request("webhook.send", input))).rejects.toThrow(/size limit/i);

    expect(() => new GmailBusinessActionAdapter([{
      id: "bad",
      companyId: "company-a",
      environment: "production",
      credentialRef: "raw-secret"
    }])).toThrow(/credential reference/i);
  });
});
