import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject
} from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresAuthAdapter } from "@/lib/auth/postgres-adapter";
import { PostgresPasskeySignInService } from "@/lib/auth/postgres-sign-in";
import { authorizeRequest } from "@/lib/auth/guard";
import { readWebAuthnServerConfig } from "@/lib/auth/webauthn-config";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  PostgresControlApiScopeResolver
} from "@/lib/control-api/postgres-auth";
import { createPostgresControlApiAdapter } from "@/lib/control-api/postgres-runtime.server";
import { resetPostgresRuntimeForTests } from "@/lib/persistence/postgres/runtime.server";

const integrationEnabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const describeIntegration = integrationEnabled ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL ?? "";
const rpId = "getdone.test";
const origin = "https://app.getdone.test";

function assertionFor(
  challenge: { challenge: string; rpId: string },
  credentialId: string,
  privateKey: KeyObject,
  counter: number
) {
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.get",
    challenge: challenge.challenge,
    origin,
    crossOrigin: false
  }));
  const authenticatorData = Buffer.alloc(37);
  createHash("sha256").update(challenge.rpId).digest().copy(authenticatorData, 0);
  authenticatorData[32] = 0x05;
  authenticatorData.writeUInt32BE(counter, 33);
  const signed = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientDataJSON).digest()
  ]);
  return {
    id: credentialId,
    type: "public-key" as const,
    response: {
      clientDataJSON: clientDataJSON.toString("base64url"),
      authenticatorData: authenticatorData.toString("base64url"),
      signature: sign("sha256", signed, privateKey).toString("base64url"),
      userHandle: null
    }
  };
}

function request(token: string, portfolioId = "portfolio-a") {
  return new Request("https://app.getdone.test/api/control", {
    headers: {
      authorization: `Bearer ${token}`,
      "x-getdone-portfolio-id": portfolioId
    }
  });
}

async function insertSession(
  pool: PostgresDatabase["pool"],
  input: {
    sessionId: string;
    userId: string;
    token: string;
    expiresAt?: string;
    revokedAt?: string | null;
  }
) {
  await pool.query(
    `INSERT INTO auth_sessions
      (session_id,user_id,token_hash,issued_at,expires_at,revoked_at,authenticated_at)
     VALUES($1,$2,$3,now() - interval '2 hours',$4,$5,now() - interval '2 hours')`,
    [
      input.sessionId,
      input.userId,
      sha256Hex(input.token),
      input.expiresAt ?? new Date(Date.now() + 60 * 60_000).toISOString(),
      input.revokedAt ?? null
    ]
  );
}

describeIntegration("production auth + WebAuthn persistence", () => {
  const database = new PostgresDatabase({
    connectionString: databaseUrl,
    maxConnections: 8,
    ssl: process.env.GETDONE_DB_SSL !== "false"
  });
  const pool = database.pool;
  const passkey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = passkey.publicKey.export({
    type: "spki",
    format: "pem"
  }).toString();
  const credentialId = "Y3JlZGVudGlhbC1h";
  let authToken = "";
  let signedInSessionId = "";

  async function nextCounter() {
    const result = await pool.query<{ sign_count: string | number }>(
      "SELECT sign_count FROM auth_webauthn_credentials WHERE credential_id=$1",
      [credentialId]
    );
    return Number(result.rows[0]?.sign_count ?? 0) + 1;
  }

  beforeAll(async () => {
    process.env.GETDONE_RUNTIME_ENV = "production";
    process.env.GETDONE_DATA_MODE = "authoritative";
    process.env.GETDONE_DB_SSL = process.env.GETDONE_DB_SSL ?? "false";
    process.env.GETDONE_WEBAUTHN_RP_ID = rpId;
    process.env.GETDONE_WEBAUTHN_ORIGINS = origin;
    process.env.GETDONE_SESSION_TTL_SECONDS = "3600";
    process.env.GETDONE_STEP_UP_TTL_SECONDS = "300";
    process.env.GETDONE_SIGN_IN_CHALLENGE_TTL_SECONDS = "300";

    await resetPostgresRuntimeForTests();
    await pool.query(
      `TRUNCATE
        owner_intents,
        auth_sign_in_challenges,
        auth_step_up_challenges,
        auth_webauthn_credentials,
        auth_step_up_credentials,
        auth_sessions,
        portfolio_memberships,
        company_memberships,
        organization_memberships,
        portfolios,
        companies,
        organizations,
        auth_users,
        control_plane_entities,
        idempotency_records,
        audit_events
       RESTART IDENTITY CASCADE`
    );

    await pool.query(
      `INSERT INTO auth_users(id,status)
       VALUES('user-a','active'),('user-b','active'),('user-c','active'),('user-d','active')`
    );
    await pool.query(
      `INSERT INTO organizations(id,name)
       VALUES('org-a','Org A'),('org-b','Org B')`
    );
    await pool.query(
      `INSERT INTO companies(id,organization_id,name)
       VALUES('company-a','org-a','Company A'),('company-b','org-b','Company B')`
    );
    await pool.query(
      `INSERT INTO portfolios(id,organization_id,company_id,name)
       VALUES
         ('portfolio-a','org-a','company-a','Portfolio A'),
         ('portfolio-b','org-b','company-b','Portfolio B')`
    );
    await pool.query(
      `INSERT INTO organization_memberships(user_id,organization_id,role,status)
       VALUES
         ('user-a','org-a','owner','active'),
         ('user-d','org-a','owner','active')`
    );
    await pool.query(
      `INSERT INTO company_memberships(user_id,company_id,role,status)
       VALUES
         ('user-a','company-a','owner','active'),
         ('user-d','company-a','owner','revoked')`
    );
    await pool.query(
      `INSERT INTO portfolio_memberships(user_id,portfolio_id,company_id,role,status)
       VALUES
         ('user-a','portfolio-a','company-a','owner','active'),
         ('user-d','portfolio-a','company-a','owner','active')`
    );
    await pool.query(
      `INSERT INTO auth_webauthn_credentials
        (credential_id,user_id,public_key_pem,algorithm,sign_count)
       VALUES($1,'user-a',$2,'ES256',0)`,
      [credentialId, publicKeyPem]
    );
    await pool.query(
      `INSERT INTO control_plane_entities
        (entity_type,id,portfolio_id,company_id,version,updated_at,payload)
       VALUES('decision','decision-strong','portfolio-a','company-a',1,now(),$1::jsonb)`,
      [JSON.stringify({
        id: "decision-strong",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        status: "pending",
        version: 1,
        requiresStepUp: true,
        updatedAt: new Date().toISOString()
      })]
    );

    await insertSession(pool, {
      sessionId: "session-b",
      userId: "user-b",
      token: "token-b"
    });
    await insertSession(pool, {
      sessionId: "session-c",
      userId: "user-c",
      token: "token-c"
    });
    await insertSession(pool, {
      sessionId: "session-d",
      userId: "user-d",
      token: "token-d"
    });
    await insertSession(pool, {
      sessionId: "session-expired",
      userId: "user-a",
      token: "token-expired",
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    });
    await insertSession(pool, {
      sessionId: "session-revoked",
      userId: "user-a",
      token: "token-revoked",
      revokedAt: new Date().toISOString()
    });

    const config = readWebAuthnServerConfig(process.env);
    const signIn = new PostgresPasskeySignInService(database, config);
    const challenge = await signIn.begin("user-a");
    const result = await signIn.verify(
      challenge.challengeId,
      assertionFor(challenge, credentialId, passkey.privateKey, 1)
    );
    authToken = result.token;
    signedInSessionId = result.session.sessionId;
  }, 30_000);

  afterAll(async () => {
    await resetPostgresRuntimeForTests();
    await database.close();
  });

  it("signs in with a cryptographically verified passkey and survives a new adapter instance", async () => {
    expect(authToken).toBeTruthy();
    const restartedAdapter = new PostgresAuthAdapter(database, {
      rpId,
      allowedOrigins: [origin]
    });
    const persisted = await restartedAdapter.getSession(request(authToken));
    expect(persisted).toMatchObject({
      sessionId: signedInSessionId,
      userId: "user-a"
    });
  });

  it("rejects expired and revoked persisted sessions", async () => {
    const adapter = new PostgresAuthAdapter(database, {
      rpId,
      allowedOrigins: [origin]
    });
    await expect(authorizeRequest(adapter, request("token-expired")))
      .rejects.toThrow(/active session/i);
    await expect(authorizeRequest(adapter, request("token-revoked")))
      .rejects.toThrow(/active session/i);
  });

  it("rejects missing membership, revoked company membership, and cross-company token reuse", async () => {
    const resolver = new PostgresControlApiScopeResolver(database, "production");
    const adapter = new PostgresAuthAdapter(database, {
      rpId,
      allowedOrigins: [origin]
    });

    const missing = await authorizeRequest(adapter, request("token-c"));
    await expect(resolver.resolve(missing.session, request("token-c")))
      .rejects.toThrow(/no active membership/i);

    const revoked = await authorizeRequest(adapter, request("token-d"));
    await expect(resolver.resolve(revoked.session, request("token-d")))
      .rejects.toThrow(/no active membership/i);

    const own = await authorizeRequest(adapter, request(authToken));
    await expect(resolver.resolve(own.session, request(authToken, "portfolio-b")))
      .rejects.toThrow(/no active membership/i);
  });

  it("requires fresh passkey step-up for a strong approval, then accepts it", async () => {
    const adapter = createPostgresControlApiAdapter(process.env);
    const req = request(authToken);
    const before = await adapter.authenticate(req);

    await expect(adapter.mutateDecision(before, {
      decisionId: "decision-strong",
      action: "approve",
      idempotencyKey: "strong-approval"
    })).rejects.toThrow(/step-up/i);

    const challenge = await adapter.beginStepUp(req);
    const elevated = await adapter.verifyStepUp(
      req,
      challenge.challengeId,
      assertionFor(challenge, credentialId, passkey.privateKey, await nextCounter())
    );
    expect(elevated.stepUpAuthenticatedAt).toBeTruthy();

    const after = await adapter.authenticate(req);
    expect(after.stepUpProof).toBeTruthy();
    const approved = await adapter.mutateDecision(after, {
      decisionId: "decision-strong",
      action: "approve",
      idempotencyKey: "strong-approval"
    });
    expect(approved.status).toBe("approved");
  });

  it("rejects replayed, expired, and stolen step-up challenges", async () => {
    const adapter = createPostgresControlApiAdapter(process.env);
    const req = request(authToken);

    const replay = await adapter.beginStepUp(req);
    const replayAssertion = assertionFor(
      replay,
      credentialId,
      passkey.privateKey,
      await nextCounter()
    );
    await adapter.verifyStepUp(req, replay.challengeId, replayAssertion);
    await expect(adapter.verifyStepUp(req, replay.challengeId, replayAssertion))
      .rejects.toThrow(/invalid or expired|already consumed/i);

    const expired = await adapter.beginStepUp(req);
    await pool.query(
      "UPDATE auth_step_up_challenges SET expires_at=now() - interval '1 second' WHERE challenge_id=$1",
      [expired.challengeId]
    );
    await expect(adapter.verifyStepUp(
      req,
      expired.challengeId,
      assertionFor(expired, credentialId, passkey.privateKey, await nextCounter())
    )).rejects.toThrow(/invalid or expired/i);

    const stolen = await adapter.beginStepUp(req);
    await expect(adapter.verifyStepUp(
      request("token-b"),
      stolen.challengeId,
      assertionFor(stolen, credentialId, passkey.privateKey, await nextCounter())
    )).rejects.toThrow(/different session/i);
  });
});
