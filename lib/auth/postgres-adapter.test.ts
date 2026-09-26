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

const session = {
  sessionId: "session-a",
  userId: "owner-a",
  issuedAt: "2026-09-21T22:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z",
  authenticatedAt: "2026-09-21T22:00:00Z"
};

const config = {
  rpId: "getdone.test",
  allowedOrigins: ["https://getdone.test"]
};

describe("PostgresAuthAdapter", () => {
  it("resolves opaque bearer and cookie sessions by hash rather than raw credential", async () => {
    const bearerDb = new ScriptedDatabase([{ rows: [sessionRow] }]);
    const bearer = await new PostgresAuthAdapter(bearerDb, config).getSession(
      new Request("https://getdone.test", {
        headers: { authorization: "Bearer fixture-session" }
      })
    );
    expect(bearer).toMatchObject({ sessionId: "session-a", userId: "owner-a" });
    expect(bearerDb.calls[0].values?.[0]).toBe(sha256Hex("fixture-session"));
    expect(bearerDb.calls[0].values?.[0]).not.toBe("fixture-session");
    expect(bearerDb.calls[0].text).toContain("s.revoked_at IS NULL");
    expect(bearerDb.calls[0].text).toContain("s.expires_at > now()");

    const cookieDb = new ScriptedDatabase([{ rows: [sessionRow] }]);
    await new PostgresAuthAdapter(cookieDb, config).getSession(
      new Request("https://getdone.test", {
        headers: { cookie: "other=x; getdone_session=cookie-token" }
      })
    );
    expect(cookieDb.calls[0].values?.[0]).toBe(sha256Hex("cookie-token"));
  });

  it("fails closed with no session token and revokes persisted sessions", async () => {
    const empty = new ScriptedDatabase([]);
    expect(await new PostgresAuthAdapter(empty, config).getSession(
      new Request("https://getdone.test")
    )).toBeNull();
    expect(empty.calls).toHaveLength(0);

    const revokeDb = new ScriptedDatabase([{ rowCount: 1 }]);
    await new PostgresAuthAdapter(revokeDb, config).revokeSession("session-a");
    expect(revokeDb.calls[0].text).toContain("UPDATE auth_sessions");
  });

  it("revokes other active device sessions without revoking the current session", async () => {
    const db = new ScriptedDatabase([{ rowCount: 2 }]);
    const count = await new PostgresAuthAdapter(db, config).revokeOtherSessions(
      "owner-a",
      "session-current"
    );
    expect(count).toBe(2);
    expect(db.calls[0].text).toContain("session_id<>$2");
    expect(db.calls[0].text).toContain("revoked_at IS NULL");
    expect(db.calls[0].values).toEqual(["owner-a", "session-current"]);
  });

  it("creates persisted WebAuthn challenges scoped to active user credentials", async () => {
    const db = new ScriptedDatabase([
      { rows: [{ credential_id: "Y3JlZC1h" }] },
      { rowCount: 1 }
    ]);
    const auth = new PostgresAuthAdapter(db, {
      ...config,
      stepUpTtlSeconds: 60
    });
    const challenge = await auth.beginStepUp(session);

    expect(challenge).toMatchObject({
      method: "passkey",
      rpId: "getdone.test",
      allowCredentialIds: ["Y3JlZC1h"],
      userVerification: "required"
    });
    expect(challenge.challenge.length).toBeGreaterThan(20);
    expect(db.calls[1].text).toContain("challenge_hash");
    expect(db.calls[1].text).toContain("credential_ids");
    expect(JSON.stringify(db.calls[1].values)).not.toContain(challenge.challenge);
  });

  it("requires an enrolled passkey before beginning step-up", async () => {
    const db = new ScriptedDatabase([{ rows: [] }]);
    await expect(new PostgresAuthAdapter(db, config).beginStepUp(session))
      .rejects.toThrow(/No active passkey/i);
  });

  it("rejects a stolen challenge bound to another persisted session before consuming it", async () => {
    const db = new ScriptedDatabase([{
      rows: [{
        challenge_id: "challenge-a",
        session_id: "session-other",
        challenge_hash: "a".repeat(64),
        rp_id: "getdone.test",
        allowed_origins: ["https://getdone.test"],
        require_user_verification: true,
        credential_ids: ["Y3JlZC1h"],
        issued_at: "2026-09-21T22:00:00Z",
        expires_at: "2099-01-01T00:00:00Z",
        consumed_at: null
      }]
    }]);
    await expect(new PostgresAuthAdapter(db, config).verifyStepUp(
      session,
      "challenge-a",
      {
        id: "Y3JlZC1h",
        response: {
          clientDataJSON: "AA",
          authenticatorData: "AA",
          signature: "AA"
        }
      }
    )).rejects.toThrow(/different session/i);
    expect(db.calls.some((call) => call.text.includes("SET consumed_at"))).toBe(false);
  });
});
