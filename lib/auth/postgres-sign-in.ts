import { randomBytes } from "node:crypto";
import type { AuthSession, StepUpChallenge } from "@/lib/auth/contracts";
import type { WebAuthnServerConfig } from "@/lib/auth/webauthn-config";
import {
  generateWebAuthnChallenge,
  parseWebAuthnAssertion,
  verifyWebAuthnAssertion,
  webAuthnChallengeHash,
  type WebAuthnAlgorithm
} from "@/lib/auth/webauthn";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

interface SignInChallengeRow {
  challenge_id: string;
  user_id: string;
  challenge_hash: string;
  rp_id: string;
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

function stringArray(value: unknown, label: string) {
  const parsed = typeof value === "string" ? (() => {
    try { return JSON.parse(value); } catch { return null; }
  })() : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new ControlPlaneError("FORBIDDEN", `${label} is invalid`);
  }
  return parsed as string[];
}

export interface PasskeySignInResult {
  session: AuthSession;
  token: string;
}

export class PostgresPasskeySignInService {
  constructor(
    private readonly db: PostgresTransactionalDatabase,
    private readonly config: WebAuthnServerConfig
  ) {}

  async begin(userId: string): Promise<StepUpChallenge> {
    if (!userId || userId.length > 200) {
      throw new ControlPlaneError("VALIDATION_FAILED", "User identity is invalid");
    }
    const credentials = await this.db.query<{ credential_id: string }>(
      `SELECT c.credential_id
       FROM auth_webauthn_credentials c
       JOIN auth_users u ON u.id=c.user_id
       WHERE c.user_id=$1 AND c.revoked_at IS NULL AND u.status='active'
       ORDER BY c.created_at,c.credential_id`,
      [userId]
    );
    const credentialIds = credentials.rows.map((row) => row.credential_id);
    if (credentialIds.length === 0) {
      throw new ControlPlaneError("UNAUTHENTICATED", "Passkey sign-in is unavailable");
    }

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + this.config.signInChallengeTtlSeconds * 1000
    );
    const challengeValue = generateWebAuthnChallenge();
    const challenge: StepUpChallenge = Object.freeze({
      challengeId: crypto.randomUUID(),
      expiresAt: expiresAt.toISOString(),
      method: "passkey",
      challenge: challengeValue,
      rpId: this.config.rpId,
      allowCredentialIds: Object.freeze([...credentialIds]),
      userVerification: "required"
    });

    await this.db.query(
      `INSERT INTO auth_sign_in_challenges
        (challenge_id,user_id,challenge_hash,rp_id,allowed_origins,
         require_user_verification,credential_ids,issued_at,expires_at)
       VALUES($1,$2,$3,$4,$5::jsonb,true,$6::jsonb,$7,$8)`,
      [
        challenge.challengeId,
        userId,
        webAuthnChallengeHash(challengeValue),
        this.config.rpId,
        JSON.stringify(this.config.allowedOrigins),
        JSON.stringify(credentialIds),
        now.toISOString(),
        challenge.expiresAt
      ]
    );
    return challenge;
  }

  async verify(challengeId: string, response: unknown): Promise<PasskeySignInResult> {
    const assertion = parseWebAuthnAssertion(response);

    return this.db.transaction(async (client) => {
      const challengeResult = await client.query<SignInChallengeRow>(
        `SELECT challenge_id,user_id,challenge_hash,rp_id,allowed_origins,
                require_user_verification,credential_ids,issued_at,expires_at,consumed_at
         FROM auth_sign_in_challenges
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
        throw new ControlPlaneError("FORBIDDEN", "Sign-in challenge is invalid or expired");
      }

      const allowedCredentialIds = stringArray(
        challenge.credential_ids,
        "WebAuthn sign-in credentials"
      );
      if (!allowedCredentialIds.includes(assertion.credentialId)) {
        throw new ControlPlaneError("FORBIDDEN", "WebAuthn credential is not allowed for sign-in");
      }

      const credentialResult = await client.query<CredentialRow>(
        `SELECT c.credential_id,c.user_id,c.user_handle,c.public_key_pem,c.algorithm,c.sign_count
         FROM auth_webauthn_credentials c
         JOIN auth_users u ON u.id=c.user_id
         WHERE c.credential_id=$1 AND c.user_id=$2
           AND c.revoked_at IS NULL AND u.status='active'
         FOR UPDATE OF c`,
        [assertion.credentialId, challenge.user_id]
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

      await client.query(
        `UPDATE auth_webauthn_credentials
         SET sign_count=$2,last_used_at=$3
         WHERE credential_id=$1 AND revoked_at IS NULL`,
        [credential.credential_id, verified.newSignCount, now.toISOString()]
      );

      const consumed = await client.query(
        `UPDATE auth_sign_in_challenges
         SET consumed_at=$2
         WHERE challenge_id=$1 AND consumed_at IS NULL`,
        [challengeId, now.toISOString()]
      );
      if (consumed.rowCount !== 1) {
        throw new ControlPlaneError("FORBIDDEN", "Sign-in challenge was already consumed");
      }

      const token = randomBytes(32).toString("base64url");
      const sessionId = crypto.randomUUID();
      const expiresAt = new Date(now.getTime() + this.config.sessionTtlSeconds * 1000);
      await client.query(
        `INSERT INTO auth_sessions
          (session_id,user_id,token_hash,issued_at,expires_at,authenticated_at)
         VALUES($1,$2,$3,$4,$5,$4)`,
        [
          sessionId,
          credential.user_id,
          sha256Hex(token),
          now.toISOString(),
          expiresAt.toISOString()
        ]
      );

      return {
        session: Object.freeze({
          sessionId,
          userId: credential.user_id,
          issuedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          authenticatedAt: now.toISOString()
        }),
        token
      };
    });
  }
}
