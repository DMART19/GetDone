import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  ConfiguredHttpActionAdapter,
  readConfiguredHttpOperationsFromEnv
} from "@/lib/execution/adapters/configured-http-action";
import {
  assertBusinessActionAdapterResult,
  type AuthorizedBusinessActionRequest
} from "@/lib/execution/adapters/business-action";
import { StaticBusinessActionAdapterRegistry } from "@/lib/execution/adapters/business-action-registry";
import { BusinessActionExecutionOrchestrator } from "@/lib/execution/business-action-orchestrator";
import type { BusinessActionExecutionRecord } from "@/lib/execution/business-action-orchestrator";

function request(overrides: Partial<AuthorizedBusinessActionRequest> = {}): AuthorizedBusinessActionRequest {
  const input = overrides.input ?? {
    companyId: "company-a",
    operation: "crm.contact.sync",
    payload: { contactId: "contact-1" }
  };
  return {
    id: "action-1",
    jobId: "job-1",
    scope: {
      userId: "owner",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "development"
    },
    capability: "http.request",
    input,
    inputHash: sha256Hex(input),
    authorizationConsumptionHash: "consumption-hash",
    idempotencyKey: "idempotency-1",
    timeoutMs: 5_000,
    attempt: 1,
    ...overrides
  };
}

describe("configured HTTP business action", () => {
  it("executes a server-configured operation with idempotency and typed result evidence", async () => {
    let capturedUrl = "";
    let captured: RequestInit | undefined;
    const adapter = new ConfiguredHttpActionAdapter([{
      name: "crm.contact.sync",
      companyId: "company-a",
      environment: "development",
      url: "https://api.example.com/actions/contact-sync",
      authorizationEnv: "CRM_ACTION_TOKEN"
    }], {
      env: { CRM_ACTION_TOKEN: "server-only-token" },
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        captured = init;
        return new Response(JSON.stringify({ synced: true }), {
          status: 200,
          headers: { "x-provider-operation-id": "provider-op-1" }
        });
      },
      now: () => new Date("2026-09-22T12:00:00Z")
    });

    const result = assertBusinessActionAdapterResult(await adapter.execute(request()));
    expect(result).toMatchObject({
      status: "completed",
      providerOperationId: "http:crm.contact.sync:provider-op-1",
      retryable: false,
      output: {
        providerOperationId: "provider-op-1",
        responseStatus: 200,
        observedAt: "2026-09-22T12:00:00.000Z"
      }
    });
    expect(capturedUrl).toBe("https://api.example.com/actions/contact-sync");
    const headers = captured?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer server-only-token");
    expect(headers["idempotency-key"]).toBe("idempotency-1");
    expect(JSON.parse(String(captured?.body))).not.toHaveProperty("url");
  });

  it("requires independent verification before completing consequential HTTPS work", async () => {
    let calls = 0;
    const adapter = new ConfiguredHttpActionAdapter([{
      name: "crm.contact.sync",
      companyId: "company-a",
      environment: "development",
      url: "https://api.example.com/actions/contact-sync",
      consequential: true,
      verification: {
        url: "https://api.example.com/actions/status/{providerOperationId}"
      }
    }], {
      fetchImpl: async (_url, init) => {
        calls += 1;
        return init?.method === "POST"
          ? new Response("accepted", {
              status: 202,
              headers: { "x-provider-operation-id": "provider-op-2" }
            })
          : new Response("verified", { status: 200 });
      },
      now: () => new Date("2026-09-22T12:00:00Z")
    });
    const accepted = await adapter.execute(request());
    expect(accepted).toMatchObject({
      status: "accepted",
      providerOperationId: "http:crm.contact.sync:provider-op-2"
    });
    const verified = await adapter.status({
      requestId: accepted.requestId,
      providerOperationId: accepted.providerOperationId!
    });
    expect(verified.state).toBe("completed");
    expect(calls).toBe(2);

    expect(() => new ConfiguredHttpActionAdapter([{
      name: "unsafe",
      companyId: "company-a",
      environment: "production",
      url: "https://api.example.com/action",
      consequential: true
    }])).toThrow(/independent verification/i);
  });

  it("fails closed for unconfigured operations and rejects target injection", async () => {
    const adapter = new ConfiguredHttpActionAdapter([{
      name: "crm.contact.sync",
      companyId: "company-a",
      environment: "development",
      url: "https://api.example.com/actions/contact-sync"
    }]);
    const injected = {
      companyId: "company-a",
      operation: "crm.contact.sync",
      payload: {},
      url: "https://attacker.invalid"
    };
    await expect(adapter.execute(request({ input: injected, inputHash: sha256Hex(injected) })))
      .rejects.toThrow();

    const unknown = {
      companyId: "company-a",
      operation: "unknown",
      payload: {}
    };
    await expect(adapter.execute(request({ input: unknown, inputHash: sha256Hex(unknown) })))
      .rejects.toThrow(/not configured/i);
  });

  it("stream-limits chunked responses before buffering the full body", async () => {
    let cancelled = false;
    const chunks = [
      new TextEncoder().encode("abc"),
      new TextEncoder().encode("def"),
      new TextEncoder().encode("should-not-be-buffered")
    ];
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index++]);
      },
      cancel() {
        cancelled = true;
      }
    }, { highWaterMark: 0 });

    const adapter = new ConfiguredHttpActionAdapter([{
      name: "crm.contact.sync",
      companyId: "company-a",
      environment: "development",
      url: "https://api.example.com/actions/contact-sync",
      maxResponseBytes: 5
    }], {
      fetchImpl: async () => new Response(body, { status: 200 })
    });

    await expect(adapter.execute(request())).rejects.toThrow(/size limit/i);
    expect(cancelled).toBe(true);
  });

  it("converts retryable HTTP failures into durable-worker retry outcomes", async () => {
    const adapter = new ConfiguredHttpActionAdapter([{
      name: "crm.contact.sync",
      companyId: "company-a",
      environment: "development",
      url: "https://api.example.com/actions/contact-sync"
    }], { fetchImpl: async () => new Response("down", { status: 503 }) });
    const result = await adapter.execute(request());
    expect(result).toMatchObject({ status: "failed", retryable: true });
  });

  it("records a verified terminal business-action result without granting adapter authority", async () => {
    const adapter = new ConfiguredHttpActionAdapter([{
      name: "crm.contact.sync",
      companyId: "company-a",
      environment: "development",
      url: "https://api.example.com/actions/contact-sync"
    }], {
      fetchImpl: async () => new Response("ok", { status: 200 }),
      now: () => new Date("2026-09-22T12:00:00Z")
    });
    let saved: BusinessActionExecutionRecord | undefined;
    const orchestrator = new BusinessActionExecutionOrchestrator(
      new StaticBusinessActionAdapterRegistry([{ capability: "http.request", adapter }]),
      {
        get: async () => saved ?? null,
        save: async (record) => { saved = record; }
      }
    );
    const result = await orchestrator.execute(request());
    expect(result.record.state).toBe("completed");
    expect(result.record.outputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.verificationEvidence).toMatchObject({
      subject: { type: "job", id: "job-1" },
      result: "pass"
    });
    expect("jobStateMutationApplied" in result.record).toBe(false);
  });

  it("routes by capability and never by a Raspberry Pi or other machine name", async () => {
    const adapter = new ConfiguredHttpActionAdapter([{
      name: "crm.contact.sync",
      companyId: "company-a",
      environment: "development",
      url: "https://api.example.com/actions/contact-sync"
    }]);
    const registry = new StaticBusinessActionAdapterRegistry([
      { capability: "http.request", adapter }
    ]);
    await expect(registry.resolve(request())).resolves.toBe(adapter);
    await expect(registry.resolve(request({ capability: "raspberryPi5" }))).resolves.toBeNull();
  });

  it("parses deployment configuration without accepting embedded credentials", () => {
    expect(readConfiguredHttpOperationsFromEnv({
      GETDONE_HTTP_ACTIONS_JSON: JSON.stringify([{
        name: "crm.contact.sync",
        companyId: "company-a",
        environment: "development",
        url: "https://api.example.com/action",
        authorizationEnv: "CRM_ACTION_TOKEN"
      }])
    })).toHaveLength(1);
    expect(() => new ConfiguredHttpActionAdapter([{
      name: "bad",
      companyId: "company-a",
      environment: "development",
      url: "https://user:secret@example.com/action"
    }])).toThrow(/credentials/i);
  });
});
