import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { postgresTlsConnection } from "../lib/persistence/postgres/tls.ts";
import {
  fileSha256,
  readSnapshotComponents,
  sha256Hex,
  snapshotHashes
} from "./postgres-backup-integrity.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function postgresCliEnv(connectionString) {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must be PostgreSQL");
  }
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: process.env.GETDONE_DB_SSL === "false"
      ? "disable"
      : (url.searchParams.get("sslmode") || process.env.PGSSLMODE || "verify-full")
  };
}

const runtime = required("GETDONE_RUNTIME_ENV");
if (runtime !== "staging") {
  throw new Error("db:create-staging-backup requires GETDONE_RUNTIME_ENV=staging");
}

// Prevent the dump and all newly created directories from becoming
// group/world-readable even briefly while pg_dump is writing.
process.umask(0o077);
const connectionString = required("DATABASE_URL");
const backupFile = path.resolve(required("GETDONE_BACKUP_FILE"));
const manifestFile = path.resolve(
  process.env.GETDONE_BACKUP_MANIFEST?.trim() || `${backupFile}.manifest.json`
);
const overwrite = process.env.GETDONE_BACKUP_OVERWRITE === "true";
for (const file of [backupFile, manifestFile]) {
  if (fs.existsSync(file) && !overwrite) {
    throw new Error(`Refusing to overwrite existing backup artifact: ${file}`);
  }
}
fs.mkdirSync(path.dirname(backupFile), { recursive: true });
fs.mkdirSync(path.dirname(manifestFile), { recursive: true });

const registry = JSON.parse(
  fs.readFileSync(new URL("../release/version-registry.json", import.meta.url), "utf8")
);
const expectedMigration = registry.database?.migrationVersion;
if (!expectedMigration) throw new Error("Release registry database migration is missing");

const pool = new pg.Pool({
    ...postgresTlsConnection(connectionString, process.env),
    max: 2,
    application_name: "getdone-staging-backup"
});
const client = await pool.connect();

let snapshot;
let manifest;
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

  const migration = await client.query(
    "SELECT version FROM getdone_schema_migrations ORDER BY version DESC LIMIT 1"
  );
  if (migration.rows[0]?.version !== expectedMigration) {
    throw new Error(
      `Backup source schema is stale; expected ${expectedMigration}, got ${migration.rows[0]?.version ?? "none"}`
    );
  }

  const exported = await client.query("SELECT pg_export_snapshot() AS snapshot_id");
  const snapshotId = exported.rows[0]?.snapshot_id;
  if (!snapshotId) throw new Error("PostgreSQL did not export a backup snapshot");

  const components = await readSnapshotComponents(client);
  const hashes = snapshotHashes(components);
  snapshot = {
    migrationVersion: expectedMigration,
    hashes,
    counts: {
      controlPlaneEntities: components.entities.length,
      authorizationGrants: components.authorization.grants.length,
      authorizationConsumptions: components.authorization.consumptions.length,
      jobRuntimeStates: components.jobs.runtime.length,
      jobTransactions: components.jobs.transactions.length,
      verificationReceipts: components.verificationReceipts.length,
      auditEvents: components.audit.events.length,
      auditLedgers: components.audit.heads.length
    }
  };

  const dump = spawnSync(
    process.env.GETDONE_PG_DUMP_BIN?.trim() || "pg_dump",
    [
      "--format=custom",
      "--no-owner",
      `--snapshot=${snapshotId}`,
      `--file=${backupFile}`
    ],
    {
      cwd: process.cwd(),
      env: postgresCliEnv(connectionString),
      encoding: "utf8"
    }
  );
  if (dump.status !== 0) {
    throw new Error(
      `pg_dump failed\nSTDOUT:\n${dump.stdout}\nSTDERR:\n${dump.stderr}`
    );
  }

  const backupSha256 = fileSha256(fs, backupFile);
  manifest = {
    formatVersion: "1.0.0",
    kind: "getdone-postgres-staging-backup",
    createdAt: new Date().toISOString(),
    migrationVersion: expectedMigration,
    backupSha256,
    snapshot
  };
  manifest.manifestSha256 = sha256Hex(manifest);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600
  });

  await client.query("COMMIT");

  // A valid dump is only a backup CANDIDATE, not verified recovery evidence.
  // The authoritative staging readiness gate advances only after independent
  // restore, domain/hash/audit verification, and application boot succeed.
  fs.chmodSync(backupFile, 0o600);
  fs.chmodSync(manifestFile, 0o600);

  console.log(JSON.stringify({
    ok: true,
    backupFile,
    manifestFile,
    restoreVerified: false,
    backupSha256,
    manifestSha256: manifest.manifestSha256,
    snapshot
  }, null, 2));
} catch (error) {
  try { await client.query("ROLLBACK"); } catch {}
  for (const file of [backupFile, manifestFile]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {}
  }
  throw error;
} finally {
  client.release();
  await pool.end();
}
