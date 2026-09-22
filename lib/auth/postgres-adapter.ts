import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  AuthAdapter,
  AuthSession,
  StepUpChallenge
} from "@/lib/auth/contracts";
import {
  generateWebAuthnChallenge,
  parseWebAuthnAssertion,
  verifyWebAuthnAssertion,
  webAuthnChallengeHash,
  type WebAuthnAlgorithm
} from "@/lib/auth/webauthn";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

interface SessionRow {
  session_id: string;
  user_id: string;
  issued_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  authenticated_at: Date | string;
  step_up_authenticated_at: Date | string | null;
}

interface ChallengeRow {
  challenge_id: string;
  session_id: string;
  challenge_hash: string | null;
  rp_id: string | null;
  allowed_origins: unknown;
  require_user_verification: boolean;
  credential_ids: unknown;
  issued_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
}

interface CredentialRow {
  credential_id: string;
  user_id: string;
  user_handle: string | null;
  public_key_pem: string;
  algorithm: WebAuthnAlgorithm;
  sign_count: string | number;
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function sessionFromRow(row: SessionRow): AuthSession {
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    issuedAt: iso(row.issued_at),
    expiresAt: iso(row.expires_at),
    revokedAt: row.revoked_at ? iso(row.revoked_at) : undefined,
    authenticatedAt: iso(row.authenticated_at),
    stepUpAuthenticatedAt: row.step_up_authenticated_at
      ? iso(row.step_up_authenticated_at)
      : undefined
  };
}

function readCookie(header: string | null, name: string) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function sessionToken(request: Request, cookieName: string) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return readCookie(request.headers.get("cookie"), cookieName);
}

function stringArray(value: unknown, label: string) {
  const parsed = typeof value === "string" ? (() => {
    try { return JSON.parse(value); } catch { return null; }
  })() : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new ControlPlaneError("FORBIDDEN", `${label} is invalid`);
  }
  return parsed as string[];
}

export class PostgresAuthAdapter implements AuthAdapter {
  constructor(
    private readonly db: PostgresTransactionalDatabase,
    private readonly options: {
      cookieName?: string;
      stepUpTtlSeconds?: number;
      rpId?: string;
      allowedOrigins?: readonly string[];
    } = {}
  ) {}

  async getSession(request: Request): Promise<AuthSession | null> {
    const token = sessionToken(request, this.options.cookieName ?? "getdone_session");
    if (!token) return null;
    const tokenHash = sha256Hex(token);
    const result = await this.db.query<SessionRow>(
      `SELECT s.session_id,s.user_id,s.issued_at,s.expires_at,s.revoked_at,
              s.authenticated_at,s.step_up_authenticated_at
       FROM auth_sessions s
       JOIN auth_users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND u.status='active'`,
      [tokenHash]
    );
    return result.rows[0] ? sessionFromRow(result.rows[0]) : null;
  }

  async revokeSession(sessionId: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now())
       WHERE session_id=$1`,
      [sessionId]
    );
    if (result.rowCount !== 1) {
      throw new ControlPlaneError("NOT_FOUND", "Auth session was not found");
    }
  }

  private webAuthnConfig() {
    const rpId = this.options.rpId?.trim();
    const allowedOrigins = [...new Set(
      (this.options.allowedOrigins ?? []).map((value) => value.trim()).filter(Boolean)
    )];
    if (!rpId || allowedOrigins.length === 0) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "Production WebAuthn RP ID and allowed origins are required"
      );
    }
    return { rpId, allowedOrigins };
  }

  async beginStepUp(session: AuthSession): Promise<StepUpChallenge> {
    const { rpId, allowedOrigins } = this.webAuthnConfig();
    const credentials = await this.db.query<{ credential_id: string }>(
      `SELECT credential_id
       FROM auth_webauthn_credentials
       WHERE user_id=$1 AND revoked_at IS NULL
       ORDER BY created_at,credential_id`,
      [session.userId]
    );
    const credentialIds = credentials.rows.map((row) => row.credential_id);
    if (credentialIds.length === 0) {
      throw new ControlPlaneError("FORBIDDEN", "No active passkey is enrolled for this user");
    }

    const issuedAt = new Date();
    const expiresAt = new Date(
      issuedAt.getTime() + (this.options.stepUpTtlSeconds ?? 300) * 1000
    );
    const challengeValue = generateWebAuthnChallenge();
    const challenge: StepUpChallenge = Object.freeze({
      challengeId: crypto.randomUUID(),
      expiresAt: expiresAt.toISOString(),
      method: "passkey",
      challenge: challengeValue,
      rpId,
      allowCredentialIds: Object.freeze([...credentialIds]),
      userVerification: "required"
    });

    await this.db.query(
      `INSERT INTO auth_step_up_challenges
        (challenge_id,session_id,challenge_hash,rp_id,allowed_origins,
         require_user_verification,credential_ids,issued_at,expires_at)
       VALUES($1,$2,$3,$4,$5::jsonb,true,$6::jsonb,$7,$8)`,
      [
        challenge.challengeId,
        session.sessionId,
        webAuthnChallengeHash(challengeValue),
        rpId,
        JSON.stringify(allowedOrigins),
        JSON.stringify(credentialIds),
        issuedAt.toISOString(),
        challenge.expiresAt
      ]
    );
    return challenge;
  }

  async verifyStepUp(
    session: AuthSession,
    challengeId: string,
    response: unknown
  ): Promise<AuthSession> {
    const assertion = parseWebAuthnAssertion(response);

    return this.db.transaction(async (client) => {
      const challengeResult = await client.query<ChallengeRow>(
        `SELECT challenge_id,session_id,challenge_hash,rp_id,allowed_origins,
                require_user_verification,credential_ids,issued_at,expires_at,consumed_at
         FROM auth_step_up_challenges
         WHERE challenge_id=$1
         FOR UPDATE`,
        [challengeId]
      );
      const challenge = challengeResult.rows[0];
      const now = new Date();
      if (
        !challenge
        || challenge.consumed_at
        || Date.parse(iso(challenge.expires_at)) <= now.getTime()
      ) {
        throw new ControlPlaneError("FORBIDDEN", "Step-up challenge is invalid or expired");
      }
      if (challenge.session_id !== session.sessionId) {
        throw new ControlPlaneError("FORBIDDEN", "Step-up challenge belongs to a different session");
      }
      if (!challenge.challenge_hash || !challenge.rp_id) {
        throw new ControlPlaneError("FORBIDDEN", "Legacy step-up challenge cannot be used");
      }

      const sessionResult = await client.query<SessionRow>(
        `SELECT s.session_id,s.user_id,s.issued_at,s.expires_at,s.revoked_at,
                s.authenticated_at,s.step_up_authenticated_at
         FROM auth_sessions s
         JOIN auth_users u ON u.id=s.user_id
         WHERE s.session_id=$1 AND u.status='active'
         FOR UPDATE OF s`,
        [challenge.session_id]
      );
      const row = sessionResult.rows[0];
      if (
        !row
        || row.user_id !== session.userId
        || row.revoked_at
        || Date.parse(iso(row.expires_at)) <= now.getTime()
      ) {
        throw new ControlPlaneError("UNAUTHENTICATED", "Active session is required for step-up");
      }

      const allowedCredentialIds = stringArray(
        challenge.credential_ids,
        "WebAuthn challenge credentials"
      );
      if (!allowedCredentialIds.includes(assertion.credentialId)) {
        throw new ControlPlaneError("FORBIDDEN", "WebAuthn credential is not allowed for this challenge");
      }

      const credentialResult = await client.query<CredentialRow>(
        `SELECT credential_id,user_id,user_handle,public_key_pem,algorithm,sign_count
         FROM auth_webauthn_credentials
         WHERE credential_id=$1 AND user_id=$2 AND revoked_at IS NULL
         FOR UPDATE`,
        [assertion.credentialId, row.user_id]
      );
      const credential = credentialResult.rows[0];
      if (!credential) {
        throw new ControlPlaneError("FORBIDDEN", "WebAuthn credential is not active");
      }

      const verified = verifyWebAuthnAssertion({
        assertion,
        expectedChallengeHash: challenge.challenge_hash,
        rpId: challenge.rp_id,
        allowedOrigins: stringArray(challenge.allowed_origins, "WebAuthn allowed origins"),
        requireUserVerification: challenge.require_user_verification,
        credential: {
          credentialId: credential.credential_id,
          userId: credential.user_id,
          userHandle: credential.user_handle ?? undefined,
          publicKeyPem: credential.public_key_pem,
          algorithm: credential.algorithm,
          signCount: Number(credential.sign_count)
        }
      });

      const credentialUpdated = await client.query(
        `UPDATE auth_webauthn_credentials
         SET sign_count=$2,last_used_at=$3
         WHERE credential_id=$1 AND revoked_at IS NULL`,
        [credential.credential_id, verified.newSignCount, now.toISOString()]
      );
      if (credentialUpdated.rowCount !== 1) {
        throw new ControlPlaneError("CONFLICT", "WebAuthn credential changed during verification");
      }

      const consumed = await client.query(
        `UPDATE auth_step_up_challenges
         SET consumed_at=$2
         WHERE challenge_id=$1 AND consumed_at IS NULL`,
        [challengeId, now.toISOString()]
      );
      if (consumed.rowCount !== 1) {
        throw new ControlPlaneError("FORBIDDEN", "Step-up challenge was already consumed");
      }

      await client.query(
        "UPDATE auth_sessions SET step_up_authenticated_at=$2 WHERE session_id=$1",
        [row.session_id, now.toISOString()]
      );

      return sessionFromRow({
        ...row,
        step_up_authenticated_at: now.toISOString()
      });
    });
  }
}
