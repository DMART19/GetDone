import { afterEach, describe, expect, it, vi } from "vitest";
import { developmentControlPlane } from "@/lib/control-plane/client";

afterEach(() => {
  vi.unstubAllGlobals();
});

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("Control API client envelope validation", () => {
  it("returns a valid development success envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      ok: true,
      correlationId: "correlation-1",
      environment: "development",
      data: []
    })));
    await expect(developmentControlPlane.listResources()).resolves.toMatchObject({
      ok: true,
      environment: "development",
      data: []
    });
  });

  it("rejects malformed envelopes and non-JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ unexpected: true })));
    await expect(developmentControlPlane.listDecisions()).rejects.toThrow(/invalid response envelope/i);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 502 })));
    await expect(developmentControlPlane.listResources()).rejects.toThrow(/invalid response envelope/i);
  });

  it("rejects an HTTP failure that falsely claims success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      ok: true,
      correlationId: "correlation-2",
      environment: "staging",
      data: []
    }, 500)));
    await expect(developmentControlPlane.listResources()).rejects.toThrow(/inconsistent success response/i);
  });

  it("preserves a typed failure envelope instead of converting it to success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      ok: false,
      correlationId: "correlation-3",
      environment: "production",
      error: { code: "FORBIDDEN", message: "blocked" }
    }, 403)));
    await expect(developmentControlPlane.listDecisions()).resolves.toMatchObject({
      ok: false,
      environment: "production",
      error: { code: "FORBIDDEN" }
    });
  });
});
