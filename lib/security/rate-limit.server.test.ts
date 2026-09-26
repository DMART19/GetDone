import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import {
  PostgresRateLimiter,
  clientNetworkIdentity,
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
