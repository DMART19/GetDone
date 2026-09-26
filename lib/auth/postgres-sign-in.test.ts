import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject
} from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { PostgresPasskeySignInService } from "@/lib/auth/postgres-sign-in";
import { webAuthnChallengeHash } from "@/lib/auth/webauthn";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

interface ScriptedResponse {
  rows?: QueryResultRow[];
  rowCount?: number;
}

class ScriptedDatabase implements PostgresTransactionalDatabase {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];

  constructor(private readonly responses: ScriptedResponse[]) {}

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

const config = {
  rpId: "getdone.test",
  allowedOrigins: ["https://app.getdone.test"],
  cookieName: "getdone_session",
  stepUpTtlSeconds: 300,
  signInChallengeTtlSeconds: 300,
  sessionTtlSeconds: 3600,
  secureCookie: true
} as const;

function assertionFor(
  challenge: string,
  credentialId: string,
  privateKey: KeyObject,
  counter: number
) {
  const clientData = Buffer.from(JSON.stringify({
    type: "webauthn.get",
    challenge,
    origin: "https://app.getdone.test",
    crossOrigin: false
  }));
  const authenticatorData = Buffer.alloc(37);
  createHash("sha256").update("getdone.test").digest().copy(authenticatorData, 0);
  authenticatorData[32] = 0x05;
  authenticatorData.writeUInt32BE(counter, 33);
  const signedData = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientData).digest()
  ]);
  return {
    id: credentialId,
    type: "public-key" as const,
    response: {
      clientDataJSON: clientData.toString("base64url"),
      authenticatorData: authenticatorData.toString("base64url"),
      signature: sign("sha256", signedData, privateKey).toString("base64url"),
      userHandle: null
    }
  };
}

describe("PostgresPasskeySignInService", () => {
  it("creates a persisted sign-in challenge without storing the raw challenge", async () => {
    const db = new ScriptedDatabase([
      { rows: [{ credential_id: "Y3JlZC0x" }] },
      { rowCount: 1 }
    ]);
    const service = new PostgresPasskeySignInService(db, config);
    const challenge = await service.begin("owner-a");

    expect(challenge).toMatchObject({
      method: "passkey",
      rpId: "getdone.test",
      allowCredentialIds: ["Y3JlZC0x"],
      userVerification: "required"
    });
    expect(db.calls[1].text).toContain("auth_sign_in_challenges");
    expect(JSON.stringify(db.calls[1].values)).not.toContain(challenge.challenge);
    expect(db.calls[1].values?.[2]).toBe(webAuthnChallengeHash(challenge.challenge));
  });

  it("rejects invalid user identifiers and users with no enrolled passkey", async () => {
    const invalid = new PostgresPasskeySignInService(new ScriptedDatabase([]), config);
    await expect(invalid.begin("")).rejects.toThrow(/user identity is invalid/i);

    const missing = new PostgresPasskeySignInService(
      new ScriptedDatabase([{ rows: [] }]),
      config
    );
    await expect(missing.begin("owner-a")).rejects.toThrow(/sign-in is unavailable/i);
  });

  it("cryptographically verifies the assertion and persists the session", async () => {
    const credentialId = "Y3JlZC0x";
    const challenge = "fixture-sign-in-challenge";
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKeyPem = keys.publicKey.export({
      type: "spki",
      format: "pem"
    }).toString();
    const db = new ScriptedDatabase([
      {
        rows: [{
          challenge_id: "challenge-a",
          user_id: "owner-a",
          challenge_hash: webAuthnChallengeHash(challenge),
          rp_id: "getdone.test",
          allowed_origins: ["https://app.getdone.test"],
          require_user_verification: true,
          credential_ids: [credentialId],
          issued_at: new Date(Date.now() - 1_000).toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          consumed_at: null
        }]
      },
      {
        rows: [{
          credential_id: credentialId,
          user_id: "owner-a",
          user_handle: null,
          public_key_pem: publicKeyPem,
          algorithm: "ES256",
          sign_count: 0
        }]
      },
      { rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 }
    ]);

    const result = await new PostgresPasskeySignInService(db, config).verify(
      "challenge-a",
      assertionFor(challenge, credentialId, keys.privateKey, 1)
    );

    expect(result.session).toMatchObject({ userId: "owner-a" });
    expect(result.token.length).toBeGreaterThan(20);
    const sessionInsert = db.calls.find((call) => call.text.includes("INSERT INTO auth_sessions"));
    expect(sessionInsert).toBeTruthy();
    expect(JSON.stringify(sessionInsert?.values)).not.toContain(result.token);
    expect(db.calls.some((call) => call.text.includes("SET sign_count"))).toBe(true);
    expect(db.calls.some((call) => call.text.includes("SET consumed_at"))).toBe(true);
  });

  it("fails closed for expired, disallowed, missing, and already-consumed credentials", async () => {
    const assertion = {
      id: "Y3JlZC0x",
      response: {
        clientDataJSON: "e30",
        authenticatorData: "AA",
        signature: "AA"
      }
    };

    const expired = new ScriptedDatabase([{
      rows: [{
        challenge_id: "challenge-a",
        user_id: "owner-a",
        challenge_hash: "a".repeat(64),
        rp_id: "getdone.test",
        allowed_origins: ["https://app.getdone.test"],
        require_user_verification: true,
        credential_ids: ["Y3JlZC0x"],
        issued_at: new Date(Date.now() - 120_000).toISOString(),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        consumed_at: null
      }]
    }]);
    await expect(new PostgresPasskeySignInService(expired, config).verify(
      "challenge-a",
      assertion
    )).rejects.toThrow(/invalid or expired/i);

    const disallowed = new ScriptedDatabase([{
      rows: [{
        challenge_id: "challenge-b",
        user_id: "owner-a",
        challenge_hash: "a".repeat(64),
        rp_id: "getdone.test",
        allowed_origins: ["https://app.getdone.test"],
        require_user_verification: true,
        credential_ids: ["other"],
        issued_at: new Date(Date.now() - 1_000).toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        consumed_at: null
      }]
    }]);
    await expect(new PostgresPasskeySignInService(disallowed, config).verify(
      "challenge-b",
      assertion
    )).rejects.toThrow(/not allowed for sign-in/i);

    const missingCredential = new ScriptedDatabase([
      {
        rows: [{
          challenge_id: "challenge-c",
          user_id: "owner-a",
          challenge_hash: "a".repeat(64),
          rp_id: "getdone.test",
          allowed_origins: ["https://app.getdone.test"],
          require_user_verification: true,
          credential_ids: ["Y3JlZC0x"],
          issued_at: new Date(Date.now() - 1_000).toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          consumed_at: null
        }]
      },
      { rows: [] }
    ]);
    await expect(new PostgresPasskeySignInService(missingCredential, config).verify(
      "challenge-c",
      assertion
    )).rejects.toThrow(/credential is not active/i);
  });
});
