import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type {
  AuthorizedBusinessActionRequest,
  BusinessActionExecutionContext
} from "@/lib/execution/adapters/business-action";
import { ConfiguredHttpActionAdapter } from "@/lib/execution/adapters/configured-http-action";
import { ConfiguredWebhookActionAdapter } from "@/lib/execution/adapters/configured-webhook-action";
import {
  GmailBusinessActionAdapter,
  readGmailProviderConfigurationsFromEnv
} from "@/lib/execution/adapters/gmail-action";
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

function credentialContext(
  capability: string,
  providerId: string,
  scopes: readonly string[],
  material = "short-lived-test-material"
): BusinessActionExecutionContext {
  return {
    credential: {
      leaseId: `lease-${capability}`,
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

describe("ordinary integration adapters", () => {
  it("declares the governed controls required by every ordinary adapter", () => {
    const http = new ConfiguredHttpActionAdapter([{
      name: "crm.contact.sync",
      companyId: "company-a",
      environment: "production",
      url: "https://api.example.test/sync",
      credentialProviderId: "http-provider"
    }]);
    const webhook = new ConfiguredWebhookActionAdapter([{
      name: "billing.notify",
      companyId: "company-a",
      environment: "production",
      url: "https://hooks.example.test/notify",
      credentialProviderId: "webhook-provider"
    }]);
    const gmail = new GmailBusinessActionAdapter([{
      id: "gmail-primary",
      companyId: "company-a",
      environment: "production",
      credentialProviderId: "gmail-provider",
      verificationMode: "provider-object-read"
    }]);
    const slack = new SlackBusinessActionAdapter([{
      id: "slack-primary",
      companyId: "company-a",
      environment: "production",
      credentialProviderId: "slack-provider",
      verificationMode: "provider-object-read"
    }]);

    for (const adapter of [http, webhook, gmail, slack]) {
      expect(adapter.declaration).toMatchObject({
        credentialMode: "brokered-lease",
        idempotency: "required",
        providerOperationId: "required",
        auditEvidence: "hashed-provider-evidence",
        tenantEnvironmentBinding: true,
        truthSemantics: "provider-acceptance-is-not-business-truth"
      });
      expect(adapter.declaration.retryTaxonomy).toContain("rate-limit");
      expect(adapter.declaration.maxResponseBytes).toBeGreaterThan(0);
    }

    expect(gmail.declaration.cancellationSemantics).toBe("local-stop-only-after-dispatch");
    expect(slack.declaration.cancellationSemantics).toBe("provider-compensation-not-reversal");
    expect(http.declaration.cancellationSemantics).toBe("configured-provider-defined");
    expect(webhook.declaration.cancellationSemantics).toBe("configured-provider-defined");
  });

  it("keeps a consequential webhook at provider-accepted until configured verification passes", async () => {
    const calls: string[] = [];
    const adapter = new ConfiguredWebhookActionAdapter([{
      name: "billing.notify",
      companyId: "company-a",
      environment: "production",
      url: "https://hooks.example.test/notify",
      credentialProviderId: "webhook-provider",
      consequential: true,
      verification: {
        url: "https://hooks.example.test/status/{providerOperationId}"
      }
    }], {
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
    const action = request("webhook.send", input);
    const context = credentialContext("webhook.send", "webhook-provider", []);
    const accepted = await adapter.execute(action, context);
    expect(accepted.status).toBe("accepted");
    expect(accepted.providerOperationId).toBe("webhook:billing.notify:provider-123");
    const verified = await adapter.status({
      requestId: accepted.requestId,
      providerOperationId: accepted.providerOperationId!
    }, context);
    expect(verified.state).toBe("completed");
    expect(calls).toHaveLength(2);
  });

  it("fails closed on malformed Gmail and Slack provider responses", async () => {
    const gmail = new GmailBusinessActionAdapter([{
      id: "gmail-primary",
      companyId: "company-a",
      environment: "production",
      credentialProviderId: "gmail-provider",
      verificationMode: "provider-object-read",
      baseUrl: "https://gmail.example.test/"
    }], {
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
    await expect(gmail.execute(
      request("email.send", emailInput),
      credentialContext("email.send", "gmail-provider", [
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.readonly"
      ])
    )).resolves.toMatchObject({
      status: "accepted",
      retryable: true,
      retryClass: "malformed-response",
      providerOperationId: expect.stringContaining("gmail:gmail-primary:rfc822:")
    });

    const slack = new SlackBusinessActionAdapter([{
      id: "slack-primary",
      companyId: "company-a",
      environment: "production",
      credentialProviderId: "slack-provider",
      verificationMode: "provider-object-read",
      baseUrl: "https://slack.example.test/api/"
    }], {
      fetchImpl: async () => new Response('{"ok":true,"channel":"C123"}', { status: 200 }),
      now: () => new Date("2026-09-22T16:00:00Z")
    });
    const slackInput = {
      companyId: "company-a",
      channelId: "C123",
      text: "hello"
    };
    await expect(slack.execute(
      request("slack.message.send", slackInput),
      credentialContext("slack.message.send", "slack-provider", ["chat:write", "channels:history"])
    )).resolves.toMatchObject({
      status: "failed",
      retryable: false,
      retryClass: "malformed-response"
    });
  });

  it("stream-limits hostile webhook responses and rejects legacy direct-secret configuration", async () => {
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

    expect(() => readGmailProviderConfigurationsFromEnv({
      GETDONE_GMAIL_ACTIONS_JSON: JSON.stringify([{
        id: "bad",
        companyId: "company-a",
        environment: "production",
        credentialRef: "env:GMAIL_TOKEN"
      }])
    })).toThrow();
  });
});
