import crypto from "node:crypto";
import pg from "pg";

const legacyRuntimeEnvironment = process.env.GETDONE_RUNTIME_ENV?.trim();
if (
  legacyRuntimeEnvironment !== "development"
  && legacyRuntimeEnvironment !== "staging"
) {
  throw new Error(
    "auth:provision-owner requires explicit development/staging; use npm run production:bootstrap for production"
  );
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const connectionString = required("DATABASE_URL");
const userId = required("GETDONE_OWNER_USER_ID");
const organizationId = required("GETDONE_OWNER_ORGANIZATION_ID");
const portfolioId = required("GETDONE_OWNER_PORTFOLIO_ID");
const companyId = required("GETDONE_OWNER_COMPANY_ID");
const sessionToken = required("GETDONE_OWNER_SESSION_TOKEN");
const credentialId = required("GETDONE_OWNER_PASSKEY_CREDENTIAL_ID");
const publicKeyPem = Buffer.from(
  required("GETDONE_OWNER_PASSKEY_PUBLIC_KEY_PEM_B64"),
  "base64"
).toString("utf8");
const passkeyAlgorithm = process.env.GETDONE_OWNER_PASSKEY_ALGORITHM?.trim() || "ES256";
if (passkeyAlgorithm !== "ES256" && passkeyAlgorithm !== "RS256") {
  throw new Error("GETDONE_OWNER_PASSKEY_ALGORITHM must be ES256 or RS256");
}
const userHandle = process.env.GETDONE_OWNER_PASSKEY_USER_HANDLE?.trim() || null;
const organizationName = process.env.GETDONE_OWNER_ORGANIZATION_NAME?.trim() || organizationId;
const companyName = process.env.GETDONE_OWNER_COMPANY_NAME?.trim() || companyId;
const portfolioName = process.env.GETDONE_OWNER_PORTFOLIO_NAME?.trim() || portfolioId;
const ttlHours = Number(process.env.GETDONE_OWNER_SESSION_TTL_HOURS || "24");
if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
  throw new Error("GETDONE_OWNER_SESSION_TTL_HOURS must be positive");
}

try {
  crypto.createPublicKey(publicKeyPem);
} catch {
  throw new Error("GETDONE_OWNER_PASSKEY_PUBLIC_KEY_PEM_B64 must decode to a valid public key");
}

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const now = new Date();
const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60_000);
const sessionId = process.env.GETDONE_OWNER_SESSION_ID?.trim() || crypto.randomUUID();

const pool = new pg.Pool({
  connectionString,
  max: 1,
  application_name: "getdone-owner-provisioner",
  ssl: process.env.GETDONE_DB_SSL === "false" ? false : { rejectUnauthorized: true }
});

const client = await pool.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await client.query(
    `INSERT INTO auth_users(id,status) VALUES($1,'active')
     ON CONFLICT (id) DO UPDATE SET status='active'`,
    [userId]
  );
  await client.query(
    `INSERT INTO organizations(id,name) VALUES($1,$2)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name`,
    [organizationId, organizationName]
  );
  await client.query(
    `INSERT INTO companies(id,organization_id,name)
     VALUES($1,$2,$3)
     ON CONFLICT (id) DO UPDATE
       SET organization_id=EXCLUDED.organization_id,name=EXCLUDED.name`,
    [companyId, organizationId, companyName]
  );
  await client.query(
    `INSERT INTO portfolios(id,organization_id,company_id,name)
     VALUES($1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE
       SET organization_id=EXCLUDED.organization_id,
           company_id=EXCLUDED.company_id,
           name=EXCLUDED.name`,
    [portfolioId, organizationId, companyId, portfolioName]
  );
  await client.query(
    `INSERT INTO organization_memberships(user_id,organization_id,role,status)
     VALUES($1,$2,'owner','active')
     ON CONFLICT (user_id,organization_id) DO UPDATE SET role='owner',status='active'`,
    [userId, organizationId]
  );
  await client.query(
    `INSERT INTO company_memberships(user_id,company_id,role,status)
     VALUES($1,$2,'owner','active')
     ON CONFLICT (user_id,company_id) DO UPDATE SET role='owner',status='active'`,
    [userId, companyId]
  );
  await client.query(
    `INSERT INTO portfolio_memberships(user_id,portfolio_id,company_id,role,status)
     VALUES($1,$2,$3,'owner','active')
     ON CONFLICT (user_id,portfolio_id)
     DO UPDATE SET company_id=EXCLUDED.company_id,role='owner',status='active'`,
    [userId, portfolioId, companyId]
  );
  await client.query(
    `INSERT INTO auth_webauthn_credentials
      (credential_id,user_id,user_handle,public_key_pem,algorithm,sign_count)
     VALUES($1,$2,$3,$4,$5,0)
     ON CONFLICT (credential_id)
     DO UPDATE SET user_id=EXCLUDED.user_id,
                   user_handle=EXCLUDED.user_handle,
                   public_key_pem=EXCLUDED.public_key_pem,
                   algorithm=EXCLUDED.algorithm,
                   sign_count=0,
                   revoked_at=NULL`,
    [credentialId, userId, userHandle, publicKeyPem, passkeyAlgorithm]
  );
  await client.query(
    `INSERT INTO auth_sessions
      (session_id,user_id,token_hash,issued_at,expires_at,authenticated_at)
     VALUES($1,$2,$3,$4,$5,$4)
     ON CONFLICT (session_id)
     DO UPDATE SET token_hash=EXCLUDED.token_hash,
                   issued_at=EXCLUDED.issued_at,
                   expires_at=EXCLUDED.expires_at,
                   revoked_at=NULL,
                   authenticated_at=EXCLUDED.authenticated_at,
                   step_up_authenticated_at=NULL`,
    [sessionId, userId, hash(sessionToken), now.toISOString(), expiresAt.toISOString()]
  );
  await client.query("COMMIT");
  console.log(JSON.stringify({
    sessionId,
    userId,
    organizationId,
    companyId,
    portfolioId,
    credentialId,
    passkeyAlgorithm,
    expiresAt: expiresAt.toISOString()
  }, null, 2));
} catch (error) {
  try { await client.query("ROLLBACK"); } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
