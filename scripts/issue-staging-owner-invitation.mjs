import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import { postgresTlsConnection } from "../lib/persistence/postgres/tls.ts";

if (process.env.GETDONE_RUNTIME_ENV !== "staging") throw new Error("Staging-only invitation issuer");
const dbUrl = process.env.DATABASE_URL;
const rpId = process.env.GETDONE_WEBAUTHN_RP_ID;
const origin = process.env.GETDONE_WEBAUTHN_ORIGINS;
const index = process.argv.indexOf("--invitation-file");
const file = index >= 0 ? process.argv[index + 1] : undefined;
if (!dbUrl || !rpId || !origin || !file || file.startsWith("--")) {
  throw new Error("Requires DATABASE_URL, GETDONE_RUNTIME_ENV=staging, GETDONE_WEBAUTHN_RP_ID, GETDONE_WEBAUTHN_ORIGINS and --invitation-file <private path>");
}
const origins = origin.startsWith("[") ? JSON.parse(origin) : origin.split(",").map(item => item.trim());
if (!Array.isArray(origins) || origins.length !== 1 || origins[0] !== "https://getdone-web-staging.onrender.com"
  || rpId !== "getdone-web-staging.onrender.com") {
  throw new Error("This issuer accepts only the exact approved GetDone staging origin and RP ID");
}
const token = crypto.randomBytes(32).toString("base64url");
const hash = crypto.createHash("sha256").update(token).digest("hex");
const pool = new pg.Pool({
  ...postgresTlsConnection(dbUrl, process.env),
  max: 1,
  application_name: "getdone-staging-owner-invitation"
});
let wroteFile = false;
const client = await pool.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  const owners = await client.query(
    `SELECT u.id FROM auth_users u
      JOIN organization_memberships om ON om.user_id=u.id
      WHERE u.status='active' AND om.status='active' AND om.role='owner'
      ORDER BY u.id FOR UPDATE OF u`
  );
  if (owners.rows.length !== 1) throw new Error("Expected exactly one active staging owner; no invitation issued");
  const userId = owners.rows[0].id;
  const credentials = await client.query("SELECT 1 FROM auth_webauthn_credentials WHERE user_id=$1", [userId]);
  if (credentials.rowCount !== 0) throw new Error("Owner already has a credential; recovery process required");
  const prior = await client.query(
    "SELECT consumed_at FROM auth_owner_enrollments WHERE user_id=$1 FOR UPDATE", [userId]
  );
  if (prior.rows[0]?.consumed_at) throw new Error("Consumed invitation; recovery process required");
  const userHandle = crypto.createHash("sha256").update(userId).digest("base64url");
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  await client.query(
    `INSERT INTO auth_owner_enrollments
      (user_id,token_hash,environment,rp_id,allowed_origins,user_handle,expires_at)
      VALUES($1,$2,'staging',$3,$4::jsonb,$5,$6)
      ON CONFLICT(user_id) DO UPDATE SET
       token_hash=EXCLUDED.token_hash,environment=EXCLUDED.environment,
       rp_id=EXCLUDED.rp_id,allowed_origins=EXCLUDED.allowed_origins,
       user_handle=EXCLUDED.user_handle,expires_at=EXCLUDED.expires_at,
       challenge_hash=NULL,challenge_expires_at=NULL
      WHERE auth_owner_enrollments.consumed_at IS NULL`,
    [userId,hash,rpId,JSON.stringify(origins),userHandle,expiresAt]
  );
  fs.writeFileSync(file, JSON.stringify({
    expiresAt,
    enrollmentUrl: origins[0] + "/setup/owner#" + token
  },null,2)+"\n", {mode:0o600,flag:"wx"});
  wroteFile=true;
  await client.query("COMMIT");
  console.log("Staging invitation issued. Open the private invitation file on the owner's device; expires "+expiresAt+". Do not paste its URL into chats or logs.");
} catch (err) {
  await client.query("ROLLBACK").catch(()=>{});
  if (wroteFile) fs.rmSync(file,{force:true});
  throw err;
} finally {
  client.release();
  await pool.end();
}
