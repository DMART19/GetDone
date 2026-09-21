import { describe, expect, it } from "vitest";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { PostgresAuthAdapter } from "@/lib/auth/postgres-adapter";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

interface Response {
  rows?: QueryResultRow[];
  rowCount?: number;
}

class ScriptedDatabase implements PostgresTransactionalDatabase {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  constructor(private readonly responses: Response[]) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    const response = this.responses.shift() ?? { rows: [], rowCount: 1 };
    return {
      command: "",
      rowCount: response.rowCount ?? response.rows?.length ?? 0,
      oid: 0,
      fields: [],
      rows: (response.rows ?? []) as R[]
    };
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
    return operation(this as unknown as PoolClient);
  }
}

const sessionRow = {
  session_id: "session-a",
  user_id: "owner-a",
  issued_at: "2026-09-21T22:00:00Z",
  expires_at: "2099-01-01T00:00:00Z",
  revoked_at: null,
  authenticated_at: "2026-09-21T22:00:00Z",
  step_up_authenticated_at: null
};

describe("PostgresAuthAdapter", () => {
  it("resolves opaque bearer and cookie sessions by hash rather than raw credential", async () => {
    const bearerDb = new ScriptedDatabase([{ rows: [sessionRow] }]);
    const bearer = await new PostgresAuthAdapter(bearerDb).getSession(
      new Request("https://getdone.test", {
        headers: { authorization: "Bearer fixture-session" }
      })
    );
    expect(bearer).toMatchObject({ sessionId: "session-a", userId: "owner-a" });
    expect(bearerDb.calls[0].values?.[0]).toBe(sha256Hex("fixture-session"));
    expect(bearerDb.calls[0].values?.[0]).not.toBe("fixture-session");

    const cookieDb = new ScriptedDatabase([{ rows: [sessionRow] }]);
    await new PostgresAuthAdapter(cookieDb).getSession(
      new Request("https://getdone.test", {
        headers: { cookie: "other=x; getdone_session=cookie-token" }
      })
    );
    expect(cookieDb.calls[0].values?.[0]).toBe(sha256Hex("cookie-token"));
  });

  it("fails closed with no production session token and revokes persisted sessions", async () => {
    const empty = new ScriptedDatabase([]);
    expect(await new PostgresAuthAdapter(empty).getSession(
      new Request("https://getdone.test")
    )).toBeNull();
    expect(empty.calls).toHaveLength(0);

    const revokeDb = new ScriptedDatabase([{ rowCount: 1 }]);
    await new PostgresAuthAdapter(revokeDb).revokeSession("session-a");
    expect(revokeDb.calls[0].text).toContain("UPDATE auth_sessions");
  });

  it("creates persisted step-up challenges and rejects missing verification tokens", async () => {
    const db = new ScriptedDatabase([{ rowCount: 1 }]);
    const auth = new PostgresAuthAdapter(db, { stepUpTtlSeconds: 60 });
    const challenge = await auth.beginStepUp({
      sessionId: "session-a",
      userId: "owner-a",
      issuedAt: "2026-09-21T22:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
      authenticatedAt: "2026-09-21T22:00:00Z"
    });

    expect(challenge.method).toBe("provider");
    expect(db.calls[0].text).toContain("INSERT INTO auth_step_up_challenges");
    await expect(auth.verifyStepUp(challenge.challengeId, {}))
      .rejects.toThrow(/step-up token is required/i);
  });

  it("consumes a valid session-bound step-up credential exactly through locked DB state", async () => {
    const challenge = {
      challenge_id: "challenge-a",
      session_id: "session-a",
      issued_at: "2026-09-21T22:00:00Z",
      expires_at: "2099-01-01T00:00:00Z",
      consumed_at: null
    };
    const db = new ScriptedDatabase([
      { rows: [challenge] },
      { rows: [sessionRow] },
      { rows: [{ secret_hash: sha256Hex("fixture-step-up") }] },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);
    const elevated = await new PostgresAuthAdapter(db).verifyStepUp(
      challenge.challenge_id,
      { token: "fixture-step-up" }
    );

    expect(elevated.stepUpAuthenticatedAt).toBeTruthy();
    expect(db.calls[0].text).toContain("FOR UPDATE");
    expect(db.calls[1].text).toContain("FOR UPDATE OF s");
    expect(db.calls.some((call) => call.text.includes("consumed_at"))).toBe(true);
  });

  it("rejects invalid persisted step-up credentials", async () => {
    const db = new ScriptedDatabase([
      {
        rows: [{
          challenge_id: "challenge-a",
          session_id: "session-a",
          issued_at: "2026-09-21T22:00:00Z",
          expires_at: "2099-01-01T00:00:00Z",
          consumed_at: null
        }]
      },
      { rows: [sessionRow] },
      { rows: [{ secret_hash: sha256Hex("fixture-other") }] }
    ]);

    await expect(new PostgresAuthAdapter(db).verifyStepUp(
      "challenge-a",
      { token: "fixture-wrong" }
    )).rejects.toThrow(/credential is invalid/i);
  });
});
