import { describe, expect, it, vi } from "vitest";
import { ConfiguredHttpActionAdapter } from "@/lib/execution/adapters/configured-http-action";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  assertProviderSuccessEnvelope,
  readBoundedProviderBody,
  readBoundedProviderJson
} from "@/lib/security/provider-response-boundary";
import {
  assertSafeConfiguredProviderUrl,
  guardedProviderFetch,
  isForbiddenProviderAddress
} from "@/lib/security/outbound-provider-http";

describe("requirements 42-43 provider boundary hardening", () => {
  it("rejects malformed JSON, hostile content types, invalid UTF-8, deep payloads and huge bodies", async () => {
    await expect(readBoundedProviderJson(
      new Response("{not-json", { headers: { "content-type": "application/json" } }),
      1024
    )).rejects.toThrow(/malformed JSON/i);

    await expect(readBoundedProviderJson(
      new Response("{}", { headers: { "content-type": "application/octet-stream" } }),
      1024
    )).rejects.toThrow(/content type/i);

    const invalidUtf8 = new Uint8Array([0xc3, 0x28]);
    await expect(readBoundedProviderBody(new Response(invalidUtf8), 1024))
      .rejects.toThrow(/UTF-8/i);

    let nested: unknown = "leaf";
    for (let i = 0; i < 70; i += 1) nested = { child: nested };
    await expect(readBoundedProviderJson(
      new Response(JSON.stringify(nested), { headers: { "content-type": "application/json" } }),
      200_000
    )).rejects.toThrow(/nesting limit/i);

    await expect(readBoundedProviderBody(
      new Response("x".repeat(64)),
      8
    )).rejects.toThrow(/size limit/i);
  });

  it("fails closed on truncated and slow streaming response bodies", async () => {
    const truncated = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'));
        controller.error(new Error("socket reset"));
      }
    });
    await expect(readBoundedProviderBody(new Response(truncated), 1024))
      .rejects.toThrow(/truncated/i);

    const never = new ReadableStream<Uint8Array>({ pull() {} });
    await expect(readBoundedProviderBody(new Response(never), 1024, { readTimeoutMs: 5 }))
      .rejects.toThrow(/timed out/i);
  });

  it("rejects false success indicators and conflicting provider identifiers", () => {
    expect(() => assertProviderSuccessEnvelope('{"ok":false}', "op-1"))
      .toThrow(/false success/i);
    expect(() => assertProviderSuccessEnvelope('{"success":false}', "op-1"))
      .toThrow(/false success/i);
    expect(() => assertProviderSuccessEnvelope('{"error":"failed"}', "op-1"))
      .toThrow(/error/i);
    expect(() => assertProviderSuccessEnvelope('{"id":"op-2"}', "op-1"))
      .toThrow(/conflict/i);
    expect(() => assertProviderSuccessEnvelope(
      '{"id":"op-1","operationId":"op-2"}',
      null
    )).toThrow(/conflicting/i);
  });

  it("blocks credential smuggling, metadata/private targets and reserved IP literals", () => {
    expect(() => assertSafeConfiguredProviderUrl(
      "https://user:secret@example.com/hook",
      "target"
    )).toThrow(/credentials/i);
    expect(() => assertSafeConfiguredProviderUrl(
      "https://169.254.169.254/latest/meta-data",
      "target"
    )).toThrow(/private|reserved/i);
    expect(() => assertSafeConfiguredProviderUrl(
      "https://metadata.google.internal/computeMetadata/v1",
      "target"
    )).toThrow(/forbidden/i);
    expect(isForbiddenProviderAddress("127.0.0.1")).toBe(true);
    expect(isForbiddenProviderAddress("10.1.2.3")).toBe(true);
    expect(isForbiddenProviderAddress("169.254.169.254")).toBe(true);
    expect(isForbiddenProviderAddress("8.8.8.8")).toBe(false);
  });

  it("prevents origin changes, redirect SSRF and DNS rebinding into private networks", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" }
    }));
    await expect(guardedProviderFetch({
      url: "https://api.example.com/action",
      expectedOrigin: "https://api.example.com",
      fetchImpl: fetchImpl as typeof fetch,
      resolver: async () => ["93.184.216.34"],
      init: { method: "POST" }
    })).rejects.toThrow(/redirect/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(guardedProviderFetch({
      url: "https://attacker.example/action",
      expectedOrigin: "https://api.example.com",
      fetchImpl: fetchImpl as typeof fetch,
      resolver: async () => ["93.184.216.34"],
      init: {}
    })).rejects.toThrow(/change configured origin/i);

    const blockedFetch = vi.fn(async () => new Response("ok"));
    await expect(guardedProviderFetch({
      url: "https://api.example.com/action",
      expectedOrigin: "https://api.example.com",
      fetchImpl: blockedFetch as typeof fetch,
      resolver: async () => ["10.0.0.7"],
      init: {}
    })).rejects.toThrow(/private|loopback|reserved/i);
    expect(blockedFetch).not.toHaveBeenCalled();
  });

  it("keeps Job input from choosing or rewriting configured HTTP targets", async () => {
    let called = false;
    const adapter = new ConfiguredHttpActionAdapter([{
      name: "safe",
      companyId: "company-a",
      environment: "production",
      url: "https://api.example.com/action"
    }], {
      resolveHostname: async () => ["169.254.169.254"],
      fetchImpl: async () => {
        called = true;
        return new Response("ok");
      }
    });

    const input = { companyId: "company-a", operation: "safe", payload: {} };
    const request = {
      id: "request-1",
      jobId: "job-1",
      scope: {
        userId: "owner",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        environment: "production" as const
      },
      capability: "http.request",
      input,
      inputHash: sha256Hex(input),
      authorizationConsumptionHash: "b".repeat(64),
      idempotencyKey: "idem-1",
      timeoutMs: 5000,
      attempt: 1
    };

    const result = await adapter.execute(request);
    expect(result.status).toBe("failed");
    expect(called).toBe(false);

    const injected = { ...input, url: "https://attacker.invalid" };
    await expect(adapter.execute({
      ...request,
      input: injected,
      inputHash: sha256Hex(injected)
    })).rejects.toThrow();
  });
});
