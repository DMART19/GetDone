import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneError } from "@/lib/control-plane/errors";

const mocks = vi.hoisted(() => ({ begin: vi.fn(), complete: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/auth/owner-enrollment.server", () => ({ OwnerEnrollmentService: class {
  begin = mocks.begin;
  complete = mocks.complete;
} }));
vi.mock("@/lib/persistence/postgres/runtime.server", () => ({ getPostgresRuntimeFromEnv: () => ({ database: {} }) }));
vi.mock("@/lib/security/rate-limit.server", () => ({
  RATE_LIMIT_POLICIES: { authBegin: {} }, clientNetworkIdentity: () => "local-test",
  enforceRateLimit: mocks.limit, rateLimitHeaders: () => ({})
}));
import { handleOwnerEnrollment } from "./owner-enrollment-http";

const token = "a".repeat(43);
function request(body?: string, origin = "https://app.example.com") {
  return new Request("https://app.example.com/api/control/auth/enrollment/begin", {
    method: "POST", headers: { origin, authorization: "Bearer cannot-bypass-origin" }, body
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("GETDONE_RUNTIME_ENV", "production");
  vi.stubEnv("GETDONE_WEBAUTHN_RP_ID", "app.example.com");
  vi.stubEnv("GETDONE_WEBAUTHN_ORIGINS", "https://app.example.com");
});
afterEach(() => vi.unstubAllEnvs());

describe("owner enrollment HTTP boundary", () => {
  it("rejects an untrusted origin even with a bearer header", async () => {
    const response = await handleOwnerEnrollment(request(JSON.stringify({ token }), "https://attacker.example"), "begin");
    expect(response.status).toBe(403); expect(mocks.begin).not.toHaveBeenCalled();
  });
  it.each([undefined, "{", JSON.stringify({ token: "short" }), JSON.stringify({ token, userId: "victim" }), "x".repeat(96_001)])(
    "rejects absent, malformed, oversized or identity-injecting bodies", async body => {
      const response = await handleOwnerEnrollment(request(body), "begin");
      expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.begin).not.toHaveBeenCalled();
    }
  );
  it("returns options without caching or setting a session", async () => {
    mocks.begin.mockResolvedValue({ challenge: "random-challenge" });
    const response = await handleOwnerEnrollment(request(JSON.stringify({ token })), "begin");
    expect(response.status).toBe(200); expect(mocks.begin).toHaveBeenCalledWith(token);
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(response.headers.has("set-cookie")).toBe(false);
  });
  it("rejects invalid credential structures before registration", async () => {
    expect((await handleOwnerEnrollment(request(JSON.stringify({ token, credential: {} })), "complete")).status).toBe(400);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("passes a validated registration to verification without creating a session", async () => {
    const credential = { id: "credential", rawId: "credential", type: "public-key", response: { clientDataJSON: "data", attestationObject: "attestation" }, clientExtensionResults: {} };
    mocks.complete.mockResolvedValue({ userId: "owner" });
    const response = await handleOwnerEnrollment(request(JSON.stringify({ token, credential })), "complete");
    expect(response.status).toBe(200); expect(mocks.complete).toHaveBeenCalledWith(token, credential);
    expect(response.headers.has("set-cookie")).toBe(false);
  });
  it("preserves rate limiting and masks unexpected internal errors", async () => {
    mocks.limit.mockRejectedValueOnce(new ControlPlaneError("RATE_LIMITED", "Retry later"));
    expect((await handleOwnerEnrollment(request(JSON.stringify({ token })), "begin")).status).toBe(429);
    mocks.begin.mockRejectedValueOnce(new Error("database-secret"));
    const response = await handleOwnerEnrollment(request(JSON.stringify({ token })), "begin");
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("database-secret");
  });
});
