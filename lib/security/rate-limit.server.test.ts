import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import {
  PostgresRateLimiter,
  clientNetworkIdentity,
  enforceRateLimit,
  requestCredentialFingerprint,
  tenantRateLimitKey,
  rateLimitHeaders
} from "@/lib/security/rate-limit.server";
import { ControlPlaneError } from "@/lib/control-plane/errors";

class FakeDatabase {
  calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  constructor(private readonly counts: number[]) {}
  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    const count = this.counts.shift() ?? 1;
    return {
      command: "",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [{
        request_count: count,
        window_expires_at: "2026-09-25T02:01:00.000Z"
      }] as unknown as R[]
    };
  }
}

describe("PostgreSQL rate limiter", () => {
  it("uses an atomic upsert and never stores raw key material", async () => {
    const db = new FakeDatabase([1]);
    const result = await new PostgresRateLimiter(db).consume(
      { id: "owner.intent", limit: 2, windowSeconds: 60 },
      ["portfolio-a", "company-a", "user-secret"],
      new Date("2026-09-25T02:00:00.000Z")
    );
    expect(result).toMatchObject({ allowed: true, remaining: 1, limit: 2 });
    expect(db.calls[0].text).toContain("ON CONFLICT(policy_id,bucket_key_hash)");
    expect(db.calls[0].values?.[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(db.calls[0].values)).not.toContain("user-secret");
  });

  it("denies after the configured limit and exposes standard retry metadata", async () => {
    const db = new FakeDatabase([3]);
    const result = await new PostgresRateLimiter(db).consume(
      { id: "decision.mutation", limit: 2, windowSeconds: 60 },
      ["tenant-a"],
      new Date("2026-09-25T02:00:00.000Z")
    );
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);

    const error = new ControlPlaneError("RATE_LIMITED", "limited", {
      details: { rateLimit: result }
    });
    expect(rateLimitHeaders(error)).toMatchObject({
      "retry-after": "60",
      "ratelimit-limit": "2",
      "ratelimit-remaining": "0"
    });
  });

  it("prefers trusted edge/client address headers without persisting them directly", () => {
    expect(clientNetworkIdentity(new Request("https://getdone.test", {
      headers: { "cf-connecting-ip": "203.0.113.7" }
    }))).toBe("203.0.113.7");
    expect(clientNetworkIdentity(new Request("https://getdone.test", {
      headers: { "x-forwarded-for": "203.0.113.8, 10.0.0.1" }
    }))).toBe("203.0.113.8");
  });
});


describe("rate limit failure handling and boundary inputs", () => {
  const now = new Date("2026-09-25T02:00:00.000Z");

  it.each([
    { id: "", limit: 2, windowSeconds: 60 },
    { id: "valid", limit: 0, windowSeconds: 60 },
    { id: "valid", limit: -1, windowSeconds: 60 },
    { id: "valid", limit: 1.5, windowSeconds: 60 },
    { id: "valid", limit: 2, windowSeconds: 0 },
    { id: "valid", limit: 2, windowSeconds: 1.5 }
  ])("rejects invalid policies before database access: %j", async (policy) => {
    const db = new FakeDatabase([1]);
    await expect(new PostgresRateLimiter(db).consume(policy, ["owner"], now))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(db.calls).toHaveLength(0);
  });

  it("rejects empty or whitespace-only keys without database access", async () => {
    const db = new FakeDatabase([1]);
    await expect(new PostgresRateLimiter(db).consume(
      { id: "owner.intent", limit: 2, windowSeconds: 60 },
      [" ", ""], now
    )).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(db.calls).toHaveLength(0);
  });

  it("rejects a database result with no bucket instead of granting access", async () => {
    const db = { query: async () => ({ rows: [], rowCount: 0 }) };
    await expect(new PostgresRateLimiter(db as never).consume(
      { id: "owner.intent", limit: 2, windowSeconds: 60 },
      ["owner"], now
    )).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("handles a Date expiry and clamps retry seconds to one", async () => {
    const db = { query: async () => ({
      rows: [{ request_count: "1", window_expires_at: new Date("2026-09-25T01:59:00.000Z") }],
      rowCount: 1
    }) };
    const decision = await new PostgresRateLimiter(db as never).consume(
      { id: "owner.intent", limit: 2, windowSeconds: 60 }, ["owner"], now
    );
    expect(decision).toMatchObject({
      allowed: true, remaining: 1, retryAfterSeconds: 1,
      resetAt: "2026-09-25T01:59:00.000Z"
    });
  });

  it("falls back to real-ip and unknown-client without trusting an empty header", () => {
    expect(clientNetworkIdentity(new Request("https://getdone.test", {
      headers: { "x-real-ip": " 192.0.2.5 " }
    }))).toBe("192.0.2.5");
    expect(clientNetworkIdentity(new Request("https://getdone.test", {
      headers: { "x-forwarded-for": " 192.0.2.6, 10.0.0.1" }
    }))).toBe("192.0.2.6");
    expect(clientNetworkIdentity(new Request("https://getdone.test")))
      .toBe("unknown-client");
  });

  it("hashes authorization and provides stable keys without exposing secrets", () => {
    expect(requestCredentialFingerprint(new Request("https://getdone.test")))
      .toBe("no-authorization");
    const fingerprint = requestCredentialFingerprint(new Request("https://getdone.test", {
      headers: { authorization: " Bearer private-token " }
    }));
    expect(fingerprint).toMatch(/^authorization:[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain("private-token");
    expect(tenantRateLimitKey({ portfolioId: "p", companyId: "c" }))
      .toEqual(["tenant", "p", "c", "no-user", "no-session", "default"]);
    expect(tenantRateLimitKey({
      portfolioId: "p", companyId: "c", userId: "u", sessionId: "s"
    }, "special")).toEqual(["tenant", "p", "c", "u", "s", "special"]);
  });

  it("does not emit headers for unrelated errors or missing metadata", () => {
    expect(rateLimitHeaders(new Error("other"))).toEqual({});
    expect(rateLimitHeaders(new ControlPlaneError("RATE_LIMITED", "limited")))
      .toEqual({});
  });

  it("skips persistence only when development rate limiting is disabled", async () => {
    const decision = await enforceRateLimit(
      { id: "owner.intent", limit: 2, windowSeconds: 60 }, ["owner"],
      { env: { GETDONE_RUNTIME_ENV: "development" }, now }
    );
    expect(decision).toMatchObject({ allowed: true, remaining: 2, retryAfterSeconds: 60 });
    expect(decision.resetAt).toBe("2026-09-25T02:01:00.000Z");
  });

  it("enforces configured development limits using the injected database", async () => {
    const db = new FakeDatabase([3]);
    await expect(enforceRateLimit(
      { id: "owner.intent", limit: 2, windowSeconds: 60 }, ["owner"],
      { env: { GETDONE_RUNTIME_ENV: "development", GETDONE_RATE_LIMIT_DEVELOPMENT: "true" },
        database: db, now }
    )).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(db.calls).toHaveLength(1);
  });
});
