import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  AuthAdapter,
  AuthSession,
  StepUpChallenge
} from "@/lib/auth/contracts";
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
  issued_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
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

export class PostgresAuthAdapter implements AuthAdapter {
  constructor(
    private readonly db: PostgresTransactionalDatabase,
    private readonly options: {
      cookieName?: string;
      stepUpTtlSeconds?: number;
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

  async beginStepUp(session: AuthSession): Promise<StepUpChallenge> {
    const issuedAt = new Date();
    const expiresAt = new Date(
      issuedAt.getTime() + (this.options.stepUpTtlSeconds ?? 300) * 1000
    );
    const challenge: StepUpChallenge = Object.freeze({
      challengeId: crypto.randomUUID(),
      expiresAt: expiresAt.toISOString(),
      method: "provider"
    });
    await this.db.query(
      `INSERT INTO auth_step_up_challenges
        (challenge_id,session_id,issued_at,expires_at)
       VALUES($1,$2,$3,$4)`,
      [challenge.challengeId, session.sessionId, issuedAt.toISOString(), challenge.expiresAt]
    );
    return challenge;
  }

  async verifyStepUp(challengeId: string, response: unknown): Promise<AuthSession> {
    const token = (
      response
      && typeof response === "object"
      && "token" in response
      && typeof (response as { token?: unknown }).token === "string"
    ) ? (response as { token: string }).token : "";
    if (!token) {
      throw new ControlPlaneError("UNAUTHENTICATED", "Step-up token is required");
    }

    return this.db.transaction(async (client) => {
      const challengeResult = await client.query<ChallengeRow>(
        `SELECT challenge_id,session_id,issued_at,expires_at,consumed_at
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
      if (!row || row.revoked_at || Date.parse(iso(row.expires_at)) <= now.getTime()) {
        throw new ControlPlaneError("UNAUTHENTICATED", "Active session is required for step-up");
      }

      const credential = await client.query<{ secret_hash: string }>(
        "SELECT secret_hash FROM auth_step_up_credentials WHERE user_id=$1",
        [row.user_id]
      );
      if (!credential.rows[0] || credential.rows[0].secret_hash !== sha256Hex(token)) {
        throw new ControlPlaneError("FORBIDDEN", "Step-up credential is invalid");
      }

      await client.query(
        "UPDATE auth_step_up_challenges SET consumed_at=$2 WHERE challenge_id=$1",
        [challengeId, now.toISOString()]
      );
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
