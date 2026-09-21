import crypto from "node:crypto";
import pg from "pg";

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
const stepUpToken = required("GETDONE_OWNER_STEP_UP_TOKEN");
const organizationName = process.env.GETDONE_OWNER_ORGANIZATION_NAME?.trim() || organizationId;
const portfolioName = process.env.GETDONE_OWNER_PORTFOLIO_NAME?.trim() || portfolioId;
const ttlHours = Number(process.env.GETDONE_OWNER_SESSION_TTL_HOURS || "24");
if (!Number.isFinite(ttlHours) || ttlHours <= 0) throw new Error("GETDONE_OWNER_SESSION_TTL_HOURS must be positive");

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
    `INSERT INTO portfolio_memberships(user_id,portfolio_id,company_id,role,status)
     VALUES($1,$2,$3,'owner','active')
     ON CONFLICT (user_id,portfolio_id)
     DO UPDATE SET company_id=EXCLUDED.company_id,role='owner',status='active'`,
    [userId, portfolioId, companyId]
  );
  await client.query(
    `INSERT INTO auth_step_up_credentials(user_id,secret_hash)
     VALUES($1,$2)
     ON CONFLICT (user_id)
     DO UPDATE SET secret_hash=EXCLUDED.secret_hash,rotated_at=now()`,
    [userId, hash(stepUpToken)]
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
    portfolioId,
    companyId,
    expiresAt: expiresAt.toISOString()
  }, null, 2));
} catch (error) {
  try { await client.query("ROLLBACK"); } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
