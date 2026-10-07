import crypto from "node:crypto";
import pg from "pg";
import { postgresTlsConnection } from "../lib/persistence/postgres/tls.ts";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const connectionString = required("DATABASE_URL");
const backupRef = required("GETDONE_BACKUP_REF");
const verificationHash = required("GETDONE_BACKUP_VERIFICATION_HASH");
if (!/^[a-f0-9]{64}$/i.test(verificationHash)) {
  throw new Error("GETDONE_BACKUP_VERIFICATION_HASH must be a SHA-256 hex digest");
}

const pool = new pg.Pool({
  ...postgresTlsConnection(connectionString, process.env),
  max: 1,
  application_name: "getdone-backup-evidence"
});

const id = process.env.GETDONE_BACKUP_EVIDENCE_ID?.trim() || crypto.randomUUID();
const completedAt = process.env.GETDONE_BACKUP_COMPLETED_AT?.trim() || new Date().toISOString();
if (!Number.isFinite(Date.parse(completedAt))) {
  throw new Error("GETDONE_BACKUP_COMPLETED_AT must be a valid timestamp");
}
const backupRefHash = crypto.createHash("sha256").update(backupRef).digest("hex");
const payload = {
  id,
  completedAt: new Date(Date.parse(completedAt)).toISOString(),
  status: "verified",
  backupRefHash,
  verificationHash: verificationHash.toLowerCase()
};

try {
  await pool.query(
    `INSERT INTO database_backup_evidence
      (id,completed_at,status,backup_ref_hash,verification_hash,payload)
     VALUES($1,$2,'verified',$3,$4,$5::jsonb)`,
    [id, payload.completedAt, backupRefHash, payload.verificationHash, JSON.stringify(payload)]
  );
  console.log(JSON.stringify(payload, null, 2));
} finally {
  await pool.end();
}
