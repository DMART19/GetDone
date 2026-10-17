import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresControlApiScopeResolver } from "@/lib/control-api/postgres-auth";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";
import type { AuthSession } from "@/lib/auth/contracts";
import { PostgresRateLimiter } from "@/lib/security/rate-limit.server";

// Never create, migrate, or mutate the real staging or production database.
// Run this only against a locally provisioned, already-migrated disposable DB.
// All fixture rows are rolled back before the test releases its connection.
const url = process.env.GETDONE_AUTH_BOUNDARY_TEST_DATABASE_URL ?? "";
let disposable = false;
try {
  const parsed = new URL(url);
  disposable = process.env.GETDONE_AUTH_BOUNDARY_INTEGRATION === "true"
    && ["localhost", "127.0.0.1"].includes(parsed.hostname)
    && /^getdone_auth_test_[a-z0-9_]+$/.test(parsed.pathname.slice(1));
} catch { /* no test database configured */ }

(disposable ? describe : describe.skip)("real PostgreSQL auth role and tenant isolation", () => {
  it("allows authenticated membership resolution and rate-limit counters, but denies business authority", async () => {
    const pool = new Pool({ connectionString: url, max: 1, ssl: false });
    const client = await pool.connect();
    const suffix = randomUUID().replaceAll("-", "");
    const userA = "auth-a-" + suffix;
    const userB = "auth-b-" + suffix;
    const companyA = "company-a-" + suffix;
    const companyB = "company-b-" + suffix;
    const orgA = "org-a-" + suffix;
    const orgB = "org-b-" + suffix;
    const portfolioA = "portfolio-a-" + suffix;
    const portfolioB = "portfolio-b-" + suffix;
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO auth_users(id,status) VALUES($1,'active'),($2,'active')", [userA, userB]);
      await client.query("INSERT INTO organizations(id,name) VALUES($1,'A'),($2,'B')", [orgA, orgB]);
      await client.query("INSERT INTO companies(id,organization_id,name) VALUES($1,$2,'A'),($3,$4,'B')",
        [companyA, orgA, companyB, orgB]);
      await client.query("INSERT INTO portfolios(id,organization_id,company_id,name) VALUES($1,$2,$3,'A'),($4,$5,$6,'B')",
        [portfolioA, orgA, companyA, portfolioB, orgB, companyB]);
      await client.query("INSERT INTO organization_memberships(user_id,organization_id,role,status) VALUES($1,$2,'owner','active'),($3,$4,'owner','active')",
        [userA, orgA, userB, orgB]);
      await client.query("INSERT INTO company_memberships(user_id,company_id,role,status) VALUES($1,$2,'owner','active'),($3,$4,'owner','active')",
        [userA, companyA, userB, companyB]);
      await client.query("INSERT INTO portfolio_memberships(user_id,portfolio_id,company_id,role,status) VALUES($1,$2,$3,'owner','active'),($4,$5,$6,'owner','active')",
        [userA, portfolioA, companyA, userB, portfolioB, companyB]);

      await client.query("SET LOCAL ROLE getdone_auth_runtime");
      const who = await client.query("SELECT current_user AS role");
      expect(who.rows[0].role).toBe("getdone_auth_runtime");
      expect(Number((await client.query("SELECT count(*) AS count FROM auth_users WHERE id=$1", [userA])).rows[0].count)).toBe(1);

      const session: AuthSession = {
        userId: userA, sessionId: "test-session", issuedAt: new Date().toISOString(),
        authenticatedAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z"
      };
      const resolver = new PostgresControlApiScopeResolver(client as unknown as SqlQueryable, "staging");
      const request = (portfolioId: string) => new Request("https://staging.getdone.test/api/control", {
        headers: { "x-getdone-portfolio-id": portfolioId }
      });
      expect((await resolver.resolve(session, request(portfolioA))).scope.companyId).toBe(companyA);
      await expect(resolver.resolve(session, request(portfolioB))).rejects.toThrow(/no active membership/);

      const limiter = new PostgresRateLimiter(client as unknown as SqlQueryable);
      expect((await limiter.consume({ id: "auth.test", limit: 1, windowSeconds: 60 },
        [userA, suffix])).allowed).toBe(true);
      expect((await limiter.consume({ id: "auth.test", limit: 1, windowSeconds: 60 },
        [userA, suffix])).allowed).toBe(false);

      await client.query("SAVEPOINT denied_business");
      await expect(client.query("SELECT * FROM control_plane_entities LIMIT 1"))
        .rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT denied_business");

      await client.query("SAVEPOINT denied_identity_write");
      await expect(client.query("UPDATE auth_users SET status='disabled' WHERE id=$1", [userA]))
        .rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT denied_identity_write");

      await client.query("SET LOCAL ROLE getdone_tenant_runtime");
      const hidden = await client.query("SELECT count(*) AS count FROM auth_users WHERE id IN ($1,$2)", [userA, userB]);
      expect(Number(hidden.rows[0].count)).toBe(0);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      await pool.end();
    }
  });
});
