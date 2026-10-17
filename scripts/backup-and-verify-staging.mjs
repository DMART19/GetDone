#!/usr/bin/env node
/**
 * Staging-only recovery ceremony for a source database at the checked-out
 * release's exact migration. NEVER changes schema or writes a backup
 * "verified" record before a separate restore proves recovery.
 *
 * Source and restore credentials stay in the private operator environment.
 * Only sanitized hashes and status are printed.
 */
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { postgresTlsConnection } from "../lib/persistence/postgres/tls.ts";
import { fileSha256, sha256Hex } from "./postgres-backup-integrity.mjs";

const SOURCE_PROJECT_ID = "ddxjiszbsmmbqxuoecmg";
const STAGING_POOLER = "aws-1-ca-central-1.pooler.supabase.com";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is required");
  return value;
}
function safeUrl(name) {
  let url;
  try { url = new URL(required(name)); } catch { throw new Error(name + " must be a valid URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.password || !url.username) {
    throw new Error(name + " must be an authenticated PostgreSQL URL");
  }
  return url;
}
function assertSourceIdentity(source, restore) {
  if (process.env.GETDONE_RUNTIME_ENV !== "staging") {
    throw new Error("Only GETDONE_RUNTIME_ENV=staging is permitted");
  }
  // Only local, disposable test fixtures may bypass the exact Supabase target.
  const localTest = process.env.GETDONE_ALLOW_ISOLATED_RESTORE_TEST === "true"
    && ["127.0.0.1","localhost"].includes(source.hostname)
    && /^getdone_backup_source_[a-zA-Z0-9_]+$/.test(source.pathname.slice(1));
  const direct = source.hostname === "db." + SOURCE_PROJECT_ID + ".supabase.co"
    && decodeURIComponent(source.username) === "postgres";
  const pooled = source.hostname === STAGING_POOLER
    && decodeURIComponent(source.username) === "postgres." + SOURCE_PROJECT_ID
    && (!source.port || source.port === "5432");
  if (!localTest && !direct && !pooled) {
    throw new Error("The source must be the exact GetDone staging project");
  }
  if (!localTest && (process.env.GETDONE_DB_SSL !== "true"
    || !process.env.PGSSLROOTCERT?.trim()
    || process.env.PGSSLMODE !== "verify-full")) {
    throw new Error("Source staging requires GETDONE_DB_SSL=true, PGSSLMODE=verify-full, and a trusted PGSSLROOTCERT");
  }
  if (!["127.0.0.1","localhost"].includes(restore.hostname)) {
    throw new Error("Isolated restore admin must be on an independently managed localhost database server");
  }
  if (source.hostname === restore.hostname && source.pathname === restore.pathname) {
    throw new Error("Refusing a restore on the source database");
  }
  return localTest;
}
function run(script, env) {
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(), env: { ...process.env, ...env },
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    // Never interpolate arbitrary process output: it may contain credential-bearing URLs.
    throw new Error(script + " failed; inspect the private shell output and keep credentials secret");
  }
  let output;
  try { output = JSON.parse(result.stdout); }
  catch { throw new Error(script + " did not return a valid JSON verification receipt"); }
  if (output.ok !== true) throw new Error(script + " did not report success");
  return output;
}

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--verify-existing")) throw new Error("Only --verify-existing is supported");
const existingMode = args.includes("--verify-existing");
const source = safeUrl("DATABASE_URL");
const isolatedAdmin = safeUrl("GETDONE_RESTORE_ADMIN_DATABASE_URL");
const testMode = assertSourceIdentity(source, isolatedAdmin);
const backupFile = path.resolve(required("GETDONE_BACKUP_FILE"));
const manifestFile = path.resolve(process.env.GETDONE_BACKUP_MANIFEST?.trim() || backupFile + ".manifest.json");
if (backupFile === manifestFile) throw new Error("Backup and manifest cannot be the same file");
if (existingMode
  ? (!existsSync(backupFile) || !existsSync(manifestFile))
  : (existsSync(backupFile) || existsSync(manifestFile))) {
  throw new Error(existingMode ? "Existing backup and manifest are both required" : "Refusing to overwrite private backup files");
}
if (process.env.GETDONE_BACKUP_OVERWRITE === "true") {
  throw new Error("Backup overwrite is forbidden in the recovery ceremony");
}

const registry = JSON.parse(readFileSync(new URL("../release/version-registry.json", import.meta.url),"utf8"));
const expectedMigration = registry.database?.migrationVersion;
if (typeof expectedMigration !== "string") throw new Error("Missing source release schema version");

const backup = existingMode ? null : run("scripts/create-staging-backup.mjs", {
  GETDONE_BACKUP_FILE: backupFile,
  GETDONE_BACKUP_MANIFEST: manifestFile,
  GETDONE_BACKUP_OVERWRITE: "false"
});
const manifest = JSON.parse(readFileSync(manifestFile,"utf8"));
const backupReceipt = backup ?? {
  restoreVerified: false,backupSha256: manifest.backupSha256,
  manifestSha256: manifest.manifestSha256
};
if (backupReceipt.restoreVerified !== false
  || manifest.migrationVersion !== expectedMigration
  || manifest.backupSha256 !== backupReceipt.backupSha256
  || manifest.manifestSha256 !== backupReceipt.manifestSha256
  || sha256Hex(Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "manifestSha256"))) !== manifest.manifestSha256
  || fileSha256({ readFileSync }, backupFile) !== backupReceipt.backupSha256
  || (statSync(backupFile).mode & 0o077) !== 0) {
  throw new Error("Dump/manifest integrity, permissions or source schema mismatch");
}

// The restore is separate from the real source. It generates an independent
// database and must pass snapshot, audit, invariants, readiness, and app boot.
const restore = run("scripts/restore-staging-backup.mjs", {
  GETDONE_BACKUP_FILE: backupFile,
  GETDONE_BACKUP_MANIFEST: manifestFile,
  GETDONE_RESTORE_ADMIN_DATABASE_URL: isolatedAdmin.toString(),
  GETDONE_BACKUP_SOURCE_DATABASE_URL: source.toString(),
  GETDONE_RESTORE_DATABASE_NAME: "getdone_restore_verify_" + randomUUID().replaceAll("-",""),
  GETDONE_RESTORE_KEEP_DATABASE: "false",
  PGSSLROOTCERT: process.env.GETDONE_RESTORE_PGSSLROOTCERT || process.env.PGSSLROOTCERT,
  GETDONE_DB_SSL: testMode ? (process.env.GETDONE_DB_SSL || "false") : "true"
});
if (restore.migrationVersion !== expectedMigration
  || restore.backupSha256 !== backupReceipt.backupSha256
  || restore.snapshotHashes?.composite !== manifest.snapshot?.hashes?.composite
  || restore.invariants?.ok !== true
  || restore.audit?.ok !== true
  || restore.applicationBootability?.status !== "verified"
  || restore.applicationBootability?.persistenceConnected !== true
  || restore.applicationBootability?.authConnected !== true
  || restore.keptDatabase === true) {
  throw new Error("Independent restore did not meet all recovery acceptance conditions");
}

const recoveryProof = {
  ok: true, sourceMigration: expectedMigration,
  backupSha256: backupReceipt.backupSha256,
  manifestSha256: manifest.manifestSha256,
  snapshotCompositeHash: manifest.snapshot.hashes.composite,
  isolatedDatabase: restore.isolatedDatabase,
  restoreVerified: true,
  auditVerified: true,
  domainInvariantsVerified: true,
  applicationBootVerified: true
};

// Do NOT produce valid source readiness unless the operator also verified a
// retained private copy with the same SHA. This is explicit human attestation;
// GetDone cannot verify durable storage solely from a local filesystem.
if (process.env.GETDONE_BACKUP_DURABLE_COPY_CONFIRMED !== "true"
  || !process.env.GETDONE_BACKUP_EXTERNAL_SHA256
  || process.env.GETDONE_BACKUP_EXTERNAL_SHA256 !== backupReceipt.backupSha256
  || !process.env.GETDONE_BACKUP_REF?.trim()) {
  console.log(JSON.stringify({ ...recoveryProof,
    stagingEvidenceRecorded: false,
    reason: "Independent restore passed; retain private backup and confirm stored SHA before publishing staging readiness"
  }, null, 2));
} else {
  const pool = new pg.Pool({
    ...postgresTlsConnection(source.toString(),process.env),
    max: 1, application_name: "getdone-staging-restore-attestation"
  });
  try {
    const stillCurrent = await pool.query(
      "SELECT version FROM getdone_schema_migrations ORDER BY version DESC LIMIT 1"
    );
    if (stillCurrent.rows[0]?.version !== expectedMigration) {
      throw new Error("Staging schema changed during backup ceremony");
    }
    const evidenceId = randomUUID();
    const completedAt = new Date().toISOString();
    const backupRefHash = createHash("sha256")
      .update(required("GETDONE_BACKUP_REF")).digest("hex");
    await pool.query(
      `INSERT INTO database_backup_evidence
       (id,completed_at,status,backup_ref_hash,verification_hash,payload)
       VALUES ($1,$2,'verified',$3,$4,$5::jsonb)`,
      [evidenceId, completedAt, backupRefHash, backupReceipt.backupSha256,
        JSON.stringify({
          id: evidenceId,completedAt,status: "verified",
          source: "independent-isolated-restore",
          backupRefHash,verificationHash: backupReceipt.backupSha256,
          manifestHash: manifest.manifestSha256,
          snapshotCompositeHash: manifest.snapshot.hashes.composite,
          migrationVersion: expectedMigration,
          durableCopyOwnerConfirmed: true,
          verifiedRestoreDatabase: restore.isolatedDatabase
        })
      ]
    );
    console.log(JSON.stringify({
      ...recoveryProof, stagingEvidenceRecorded: true, completedAt
    }, null, 2));
  } finally { await pool.end(); }
}
