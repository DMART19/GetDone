import { createHash, createPublicKey } from "node:crypto";
import { generateRegistrationOptions, verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { decodeCredentialPublicKey, cose } from "@simplewebauthn/server/helpers";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { WebAuthnServerConfig } from "@/lib/auth/webauthn-config";
import type { PostgresTransactionalDatabase, SqlQueryable } from "@/lib/persistence/postgres/client";

type Enrollment = {
  user_id: string; user_handle: string; token_hash: string; environment: string;
  rp_id: string; allowed_origins: string[]; expires_at: Date; consumed_at: Date | null;
  challenge_hash: string | null; challenge_expires_at: Date | null;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new ControlPlaneError("FORBIDDEN", "Owner invitation is invalid, expired, or already used");

/** An invitation is minted only by the privileged bootstrap CLI, never by this API. */
export class OwnerEnrollmentService {
  constructor(
    private readonly db: PostgresTransactionalDatabase,
    private readonly config: WebAuthnServerConfig,
    private readonly environment: string
  ) {}

  private async lockedInvitation(client: SqlQueryable, token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !["staging", "production"].includes(this.environment)) throw unavailable();
    // Owner row first: same lock order as bootstrap invitation issuance.
    const user = await client.query<{ id: string }>(
      `SELECT u.id FROM auth_users u JOIN auth_owner_enrollments e ON e.user_id=u.id
       WHERE e.token_hash=$1 AND u.status='active' FOR UPDATE OF u`, [digest(token)]
    );
    if (!user.rows[0]) throw unavailable();
    const result = await client.query<Enrollment>(
      "SELECT * FROM auth_owner_enrollments WHERE user_id=$1 AND token_hash=$2 FOR UPDATE", [user.rows[0].id, digest(token)]
    );
    const row = result.rows[0];
    if (!row || row.consumed_at || row.expires_at.getTime() <= Date.now()
      || row.environment !== this.environment || row.rp_id !== this.config.rpId
      || !Array.isArray(row.allowed_origins) || !row.allowed_origins.length
      || row.allowed_origins.some(origin => !this.config.allowedOrigins.includes(origin))) throw unavailable();
    const existing = await client.query("SELECT 1 FROM auth_webauthn_credentials WHERE user_id=$1", [row.user_id]);
    if (existing.rowCount) throw unavailable();
    return row;
  }

  async begin(token: string) {
    return this.db.transaction(async client => {
      const row = await this.lockedInvitation(client, token);
      const options = await generateRegistrationOptions({
        rpName: "GetDone", rpID: row.rp_id,
        userName: row.user_id, userID: new Uint8Array(Buffer.from(row.user_handle, "base64url")),
        attestationType: "none", supportedAlgorithmIDs: [-7],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        timeout: 120_000
      });
      await client.query(
        `UPDATE auth_owner_enrollments SET challenge_hash=$2,
         challenge_expires_at=LEAST(expires_at,now() + interval '5 minutes') WHERE user_id=$1`,
        [row.user_id, digest(options.challenge)]
      );
      return options;
    });
  }

  async complete(token: string, credential: RegistrationResponseJSON) {
    return this.db.transaction(async client => {
      const row = await this.lockedInvitation(client, token);
      if (!row.challenge_hash || !row.challenge_expires_at || row.challenge_expires_at.getTime() <= Date.now()) throw unavailable();
      const verification = await verifyRegistrationResponse({
        response: credential,
        expectedChallenge: challenge => digest(challenge) === row.challenge_hash,
        expectedOrigin: row.allowed_origins, expectedRPID: row.rp_id,
        requireUserVerification: true, supportedAlgorithmIDs: [-7]
      }).catch(() => { throw new ControlPlaneError("FORBIDDEN", "Passkey registration could not be verified"); });
      if (!verification.verified) throw unavailable();
      const verified = verification.registrationInfo.credential;
      // Store the verified attested key in the existing assertion verifier's format.
      const key = decodeCredentialPublicKey(verified.publicKey);
      if (!cose.isCOSEPublicKeyEC2(key)) throw unavailable();
      const x = key.get(-2); const y = key.get(-3);
      if (key.get(1) !== 2 || key.get(3) !== -7 || key.get(-1) !== 1
        || !(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) throw unavailable();
      const pem = createPublicKey({ format: "jwk", key: {
        kty: "EC", crv: "P-256", x: Buffer.from(x).toString("base64url"), y: Buffer.from(y).toString("base64url")
      }}).export({ type: "spki", format: "pem" });
      await client.query(
        `INSERT INTO auth_webauthn_credentials
         (credential_id,user_id,user_handle,public_key_pem,algorithm,sign_count)
         VALUES($1,$2,$3,$4,'ES256',$5)`,
        [verified.id, row.user_id, row.user_handle, pem, verified.counter]
      );
      await client.query(
        `UPDATE auth_owner_enrollments SET consumed_at=now(),credential_id=$2,
         challenge_hash=NULL,challenge_expires_at=NULL WHERE user_id=$1`, [row.user_id, verified.id]
      );
      // No session is created here. Sign-in proves possession of the new private key.
      return { userId: row.user_id };
    });
  }
}
