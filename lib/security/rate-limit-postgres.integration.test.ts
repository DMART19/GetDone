import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDatabase, readPostgresConfigFromEnv } from "@/lib/persistence/postgres/client";
import { PostgresRateLimiter } from "@/lib/security/rate-limit.server";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const describeIntegration = enabled ? describe : describe.skip;

describeIntegration("PostgreSQL rate limiting", () => {
  let database: PostgresDatabase | undefined;

  function db() {
    if (!database) throw new Error("PostgreSQL rate limit test database is not initialized");
    return database;
  }

  beforeAll(async () => {
    database = new PostgresDatabase(readPostgresConfigFromEnv(process.env));
    await db().query("DELETE FROM rate_limit_buckets");
  });

  afterAll(async () => {
    if (!database) return;
    await database.query("DELETE FROM rate_limit_buckets");
    await database.close();
  });

  it("keeps tenant buckets independent and resets fixed windows deterministically", async () => {
    const limiter = new PostgresRateLimiter(db());
    const policy = { id: "integration.owner-intent", limit: 2, windowSeconds: 60 };
    const start = new Date("2026-09-25T02:00:00.000Z");

    expect((await limiter.consume(policy, ["portfolio-a", "company-a"], start)).allowed).toBe(true);
    expect((await limiter.consume(policy, ["portfolio-a", "company-a"], start)).allowed).toBe(true);
    expect((await limiter.consume(policy, ["portfolio-a", "company-a"], start)).allowed).toBe(false);

    const otherTenant = await limiter.consume(
      policy,
      ["portfolio-b", "company-b"],
      start
    );
    expect(otherTenant).toMatchObject({ allowed: true, remaining: 1 });

    const reset = await limiter.consume(
      policy,
      ["portfolio-a", "company-a"],
      new Date("2026-09-25T02:01:01.000Z")
    );
    expect(reset).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("is concurrency-safe across parallel consumers", async () => {
    const limiter = new PostgresRateLimiter(db());
    const policy = { id: "integration.concurrent", limit: 5, windowSeconds: 60 };
    const now = new Date("2026-09-25T03:00:00.000Z");
    const decisions = await Promise.all(
      Array.from({ length: 10 }, () =>
        limiter.consume(policy, ["portfolio-race", "company-race"], now)
      )
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(5);
    expect(Math.max(...decisions.map((decision) => decision.remaining))).toBe(4);
    expect(Math.min(...decisions.map((decision) => decision.remaining))).toBe(0);
  });
});
