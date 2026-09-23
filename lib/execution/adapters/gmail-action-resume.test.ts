import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import {
  GmailBusinessActionAdapter,
  gmailRfc822MessageId
} from "@/lib/execution/adapters/gmail-action";

const scope = Object.freeze({
  userId: "owner",
  portfolioId: "portfolio",
  companyId: "company",
  environment: "staging" as const
});

function request(id: string): AuthorizedBusinessActionRequest {
  const input = {
    companyId: scope.companyId,
    to: ["recipient@example.test"],
    cc: [],
    subject: "GetDone Gmail safety",
    text: "governed staging message"
  };
  return Object.freeze({
    id,
    jobId: "job-" + id,
    scope,
    capability: "email.send",
    input,
    inputHash: sha256Hex(input),
    authorizationConsumptionHash: "consumption-" + id,
    idempotencyKey: "idempotency-" + id,
    timeoutMs: 5_000,
    attempt: 1
  });
}

function adapter(fetchImpl: typeof fetch) {
  return new GmailBusinessActionAdapter([{
    id: "gmail-staging",
    companyId: scope.companyId,
    environment: scope.environment,
    credentialRef: "env:SEND_TOKEN",
    verificationCredentialRef: "env:READ_TOKEN",
    verificationMode: "provider-object-read"
  }], {
    env: { SEND_TOKEN: "send-token", READ_TOKEN: "read-token" },
    fetchImpl,
    now: () => new Date("2026-09-23T21:00:00.000Z")
  });
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("Gmail resumable provider-object delivery", () => {
  it("embeds a deterministic Message-ID and suppresses a duplicate provider send", async () => {
    const action = request("gmail-duplicate");
    const rfc822 = gmailRfc822MessageId(action.id);
    let sent = false;
    let postCalls = 0;
    let capturedMime = "";

    const gmail = adapter(async (url, init) => {
      const value = new URL(String(url));
      if (init?.method === "GET" && value.pathname.endsWith("/messages")) {
        return json(sent ? { messages: [{ id: "msg-duplicate" }] } : {});
      }
      if (init?.method === "POST") {
        postCalls += 1;
        sent = true;
        const body = JSON.parse(String(init.body)) as { raw: string };
        capturedMime = Buffer.from(body.raw, "base64url").toString("utf8");
        return json({ id: "msg-duplicate", threadId: "thread-duplicate" });
      }
      return json({ id: "msg-duplicate" });
    });

    const first = await gmail.execute(action);
    const duplicate = await gmail.execute(action);

    expect(first.providerOperationId).toBe("gmail:gmail-staging:msg-duplicate");
    expect(duplicate.providerOperationId).toBe(first.providerOperationId);
    expect(postCalls).toBe(1);
    expect(capturedMime).toContain("Message-ID: <" + rfc822 + ">");
  });

  it("recovers timeout-after-send by provider search instead of a second send", async () => {
    const action = request("gmail-timeout-after-send");
    let sent = false;
    let postCalls = 0;
    const gmail = adapter(async (url, init) => {
      const value = new URL(String(url));
      if (init?.method === "GET" && value.pathname.endsWith("/messages")) {
        return json(sent ? { messages: [{ id: "msg-timeout" }] } : {});
      }
      if (init?.method === "POST") {
        postCalls += 1;
        sent = true;
        throw new Error("socket closed after Gmail accepted the message");
      }
      return json({ id: "msg-timeout" });
    });

    const accepted = await gmail.execute(action);
    expect(accepted.status).toBe("accepted");
    expect(accepted.providerOperationId).toContain(":rfc822:");
    const verified = await gmail.status({
      requestId: action.id,
      providerOperationId: accepted.providerOperationId!
    });
    expect(verified.state).toBe("completed");
    expect(postCalls).toBe(1);
  });

  it("recovers a malformed success response by searching the deterministic Message-ID", async () => {
    const action = request("gmail-malformed-after-send");
    let sent = false;
    let postCalls = 0;
    const gmail = adapter(async (url, init) => {
      const value = new URL(String(url));
      if (init?.method === "GET" && value.pathname.endsWith("/messages")) {
        return json(sent ? { messages: [{ id: "msg-malformed" }] } : {});
      }
      if (init?.method === "POST") {
        postCalls += 1;
        sent = true;
        return json({ threadId: "missing-message-id" });
      }
      return json({ id: "msg-malformed" });
    });

    const accepted = await gmail.execute(action);
    expect(accepted.status).toBe("accepted");
    expect(accepted.retryClass).toBe("malformed-response");
    expect(accepted.providerOperationId).toContain(":rfc822:");
    expect((await gmail.status({
      requestId: action.id,
      providerOperationId: accepted.providerOperationId!
    })).state).toBe("completed");
    expect(postCalls).toBe(1);
  });

  it("classifies invalid credentials and Gmail 429 without claiming success", async () => {
    const invalid = adapter(async (url, init) => {
      const value = new URL(String(url));
      if (init?.method === "GET" && value.pathname.endsWith("/messages")) return json({});
      return json({ error: { code: 401 } }, 401);
    });
    const invalidResult = await invalid.execute(request("gmail-invalid-token"));
    expect(invalidResult).toMatchObject({
      status: "rejected",
      retryable: false,
      retryClass: "provider-4xx"
    });

    const limited = adapter(async (url, init) => {
      const value = new URL(String(url));
      if (init?.method === "GET" && value.pathname.endsWith("/messages")) return json({});
      return json({ error: { code: 429 } }, 429);
    });
    const limitedResult = await limited.execute(request("gmail-rate-limit"));
    expect(limitedResult).toMatchObject({
      status: "failed",
      retryable: true,
      retryClass: "rate-limit"
    });
  });

  it("fails closed when provider-object verification fails after a successful send", async () => {
    const action = request("gmail-verification-failure");
    let sent = false;
    const gmail = adapter(async (url, init) => {
      const value = new URL(String(url));
      if (init?.method === "GET" && value.pathname.endsWith("/messages")) return json({});
      if (init?.method === "POST") {
        sent = true;
        return json({ id: "msg-verification-failure" });
      }
      if (sent && init?.method === "GET") return json({ error: { code: 403 } }, 403);
      return json({});
    });

    const accepted = await gmail.execute(action);
    expect(accepted.status).toBe("accepted");
    expect((await gmail.status({
      requestId: action.id,
      providerOperationId: accepted.providerOperationId!
    })).state).toBe("failed");
  });
});
