import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { AuthSession } from "@/lib/auth/contracts";
import {
  PostgresControlApiScopeResolver,
  SessionStepUpEvidenceResolver
} from "@/lib/control-api/postgres-auth";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";

class QueryDb implements SqlQueryable {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  constructor(private readonly rows: QueryResultRow[]) {}
  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    return {
      command: "",
      rowCount: this.rows.length,
      oid: 0,
      fields: [],
      rows: this.rows as R[]
    };
  }
}

const session: AuthSession = {
  sessionId: "session-a",
  userId: "owner-a",
  issuedAt: "2026-09-21T22:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z",
  authenticatedAt: "2026-09-21T22:00:00Z"
};

describe("Postgres Control API authority resolution", () => {
  it("derives portfolio/company scope and role from active DB memberships", async () => {
    const db = new QueryDb([{
      portfolio_id: "portfolio-a",
      company_id: "company-a",
      role: "owner"
    }]);
    const resolved = await new PostgresControlApiScopeResolver(db, "production").resolve(
      session,
      new Request("https://getdone.test/api/control", {
        headers: { "x-getdone-portfolio-id": "portfolio-a" }
      })
    );

    expect(resolved).toEqual({
      scope: {
        userId: "owner-a",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        environment: "production"
      },
      role: "owner"
    });
    expect(db.calls[0].text).toContain("organization_memberships");
    expect(db.calls[0].text).toContain("company_memberships");
    expect(db.calls[0].text).toContain("pm.status='active'");
    expect(db.calls[0].values).toEqual(["owner-a", "portfolio-a"]);
  });

  it("requires explicit portfolio selection when multiple active memberships exist", async () => {
    const db = new QueryDb([
      { portfolio_id: "portfolio-a", company_id: "company-a", role: "owner" },
      { portfolio_id: "portfolio-b", company_id: "company-b", role: "admin" }
    ]);

    await expect(new PostgresControlApiScopeResolver(db, "production").resolve(
      session,
      new Request("https://getdone.test/api/control")
    )).rejects.toThrow(/X-GetDone-Portfolio-Id is required/i);
  });

  it("rejects users with no active requested portfolio membership", async () => {
    const db = new QueryDb([]);
    await expect(new PostgresControlApiScopeResolver(db, "staging").resolve(
      session,
      new Request("https://getdone.test/api/control", {
        headers: { "x-getdone-portfolio-id": "foreign-portfolio" }
      })
    )).rejects.toThrow(/no active membership/i);
  });

  it("creates server-side step-up proof only while the persisted session elevation is fresh", async () => {
    const now = new Date("2026-09-21T23:00:00Z");
    const resolver = new SessionStepUpEvidenceResolver(() => now, 5 * 60_000);
    const scope = {
      userId: "owner-a",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "production" as const
    };

    expect(await resolver.resolveStepUpProof(session, new Request("https://getdone.test"), scope))
      .toBeUndefined();

    const proof = await resolver.resolveStepUpProof({
      ...session,
      stepUpAuthenticatedAt: "2026-09-21T22:58:00Z"
    }, new Request("https://getdone.test"), scope);

    expect(proof).toMatchObject({
      actorId: "owner-a",
      scope,
      method: "reauthentication",
      authenticatedAt: "2026-09-21T22:58:00Z"
    });
    expect(proof?.proofHash).toHaveLength(64);
  });
});
