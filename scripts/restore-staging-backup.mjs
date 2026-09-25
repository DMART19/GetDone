import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import pg from "pg";
import {
  fileSha256,
  readSnapshotComponents,
  sha256Hex,
  snapshotHashes,
  verifyRestoredInvariants
} from "./postgres-backup-integrity.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function quoteIdentifier(value) {
  return '"' + value.replaceAll('"', '""') + '"';
}

function postgresCliEnv(connectionString, databaseName) {
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("GETDONE_RESTORE_ADMIN_DATABASE_URL must be PostgreSQL");
  }
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: databaseName ?? decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: process.env.GETDONE_DB_SSL === "false"
      ? "disable"
      : (url.searchParams.get("sslmode") || process.env.PGSSLMODE || "verify-full")
  };
}

function databaseUrl(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = "/" + databaseName;
  return url.toString();
}

function assertEqualHashes(expected, actual) {
  const failures = [];
  for (const key of [
    "controlPlaneEntities",
    "authorizationLineage",
    "jobState",
    "verificationReceipts",
    "auditLedger",
    "composite"
  ]) {
    if (expected?.[key] !== actual?.[key]) {
      failures.push({ component: key, expected: expected?.[key], actual: actual?.[key] });
    }
  }
  if (failures.length > 0) {
    throw new Error(`Restored snapshot hash mismatch: ${JSON.stringify(failures)}`);
  }
}

async function waitForHealth(url, child) {
  let lastError = "server did not respond";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Restored application exited before health verification with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url, { headers: { "cache-control": "no-store" } });
      const body = await response.json();
      if (
        response.ok
        && body?.ok === true
        && body?.data?.persistenceConnected === true
        && body?.data?.authConnected === true
      ) {
        return body;
      }
      lastError = `health returned ${response.status}: ${JSON.stringify(body)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Restored application health verification failed: ${lastError}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const runtime = required("GETDONE_RUNTIME_ENV");
if (runtime !== "staging") {
  throw new Error("db:restore-staging-backup requires GETDONE_RUNTIME_ENV=staging");
}

const backupFile = path.resolve(required("GETDONE_BACKUP_FILE"));
const manifestFile = path.resolve(required("GETDONE_BACKUP_MANIFEST"));
const adminConnectionString = required("GETDONE_RESTORE_ADMIN_DATABASE_URL");
if (!fs.existsSync(backupFile)) throw new Error("GETDONE_BACKUP_FILE does not exist");
if (!fs.existsSync(manifestFile)) throw new Error("GETDONE_BACKUP_MANIFEST does not exist");

const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const { manifestSha256, ...manifestBase } = manifest;
if (manifest.kind !== "getdone-postgres-staging-backup" || manifest.formatVersion !== "1.0.0") {
  throw new Error("Backup manifest kind/version is unsupported");
}
if (sha256Hex(manifestBase) !== manifestSha256) {
  throw new Error("Backup manifest integrity hash is invalid");
}
const actualBackupSha256 = fileSha256(fs, backupFile);
if (actualBackupSha256 !== manifest.backupSha256) {
  throw new Error("Backup file SHA-256 does not match its manifest");
}

const registry = JSON.parse(
  fs.readFileSync(new URL("../release/version-registry.json", import.meta.url), "utf8")
);
const expectedMigration = registry.database?.migrationVersion;
if (
  !expectedMigration
  || manifest.migrationVersion !== expectedMigration
  || manifest.snapshot?.migrationVersion !== expectedMigration
) {
  throw new Error(
    `Backup schema does not match current release migration ${expectedMigration ?? "unknown"}`
  );
}

const explicitName = process.env.GETDONE_RESTORE_DATABASE_NAME?.trim();
const targetDatabase = explicitName
  || `getdone_restore_verify_${process.pid}_${Date.now()}`;
if (!/^getdone_restore_verify_[A-Za-z0-9_]+$/.test(targetDatabase)) {
  throw new Error(
    "GETDONE_RESTORE_DATABASE_NAME must begin with getdone_restore_verify_ and contain only letters, digits, or underscores"
  );
}

const adminPool = new pg.Pool({
  connectionString: adminConnectionString,
  max: 2,
  application_name: "getdone-staging-restore-admin",
  ssl: process.env.GETDONE_DB_SSL === "false"
    ? false
    : { rejectUnauthorized: true }
});
const targetConnectionString = databaseUrl(adminConnectionString, targetDatabase);
let targetPool;
let appProcess;
let created = false;
let keepDatabase = process.env.GETDONE_RESTORE_KEEP_DATABASE === "true";

try {
  await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(targetDatabase)} WITH (FORCE)`);
  await adminPool.query(`CREATE DATABASE ${quoteIdentifier(targetDatabase)}`);
  created = true;

  const restore = spawnSync(
    process.env.GETDONE_PG_RESTORE_BIN?.trim() || "pg_restore",
    [
      "--exit-on-error",
      "--no-owner",
      `--dbname=${targetDatabase}`,
      backupFile
    ],
    {
      cwd: process.cwd(),
      env: postgresCliEnv(adminConnectionString, targetDatabase),
      encoding: "utf8"
    }
  );
  if (restore.status !== 0) {
    throw new Error(
      `pg_restore failed\nSTDOUT:\n${restore.stdout}\nSTDERR:\n${restore.stderr}`
    );
  }

  targetPool = new pg.Pool({
    connectionString: targetConnectionString,
    max: 4,
    application_name: "getdone-staging-restore-verifier",
    ssl: process.env.GETDONE_DB_SSL === "false"
      ? false
      : { rejectUnauthorized: true }
  });

  const migration = await targetPool.query(
    "SELECT version FROM getdone_schema_migrations ORDER BY version DESC LIMIT 1"
  );
  if (migration.rows[0]?.version !== expectedMigration) {
    throw new Error(
      `Restored schema is stale; expected ${expectedMigration}, got ${migration.rows[0]?.version ?? "none"}`
    );
  }

  const restoredComponents = await readSnapshotComponents(targetPool);
  const restoredHashes = snapshotHashes(restoredComponents);
  assertEqualHashes(manifest.snapshot.hashes, restoredHashes);

  const invariants = await verifyRestoredInvariants(targetPool);
  if (!invariants.ok) {
    throw new Error(`Restored domain invariants failed: ${JSON.stringify(invariants.failures)}`);
  }

  const audit = spawnSync(
    process.execPath,
    ["scripts/verify-audit-ledger-integrity.mjs"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: targetConnectionString,
        GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false"
      },
      encoding: "utf8"
    }
  );
  if (audit.status !== 0) {
    throw new Error(
      `Restored audit ledger verification failed\nSTDOUT:\n${audit.stdout}\nSTDERR:\n${audit.stderr}`
    );
  }
  const auditResult = JSON.parse(audit.stdout);

  const evidenceId = crypto.randomUUID();
  const completedAt = new Date().toISOString();
  const backupRefHash = crypto.createHash("sha256")
    .update(path.basename(backupFile))
    .digest("hex");
  await targetPool.query(
    `INSERT INTO database_backup_evidence
      (id,completed_at,status,backup_ref_hash,verification_hash,payload)
     VALUES($1,$2,'verified',$3,$4,$5::jsonb)`,
    [
      evidenceId,
      completedAt,
      backupRefHash,
      manifest.backupSha256,
      JSON.stringify({
        id: evidenceId,
        completedAt,
        status: "verified",
        source: "isolated-staging-restore-verification",
        backupRefHash,
        verificationHash: manifest.backupSha256,
        manifestHash: manifest.manifestSha256,
        snapshotCompositeHash: restoredHashes.composite
      })
    ]
  );

  const databaseReadiness = spawnSync(
    process.execPath,
    ["scripts/verify-postgres-production.mjs"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: targetConnectionString,
        GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false",
        GETDONE_DB_RUNTIME_ROLE: "getdone_tenant_runtime",
        GETDONE_BACKUP_MAX_AGE_HOURS: "24"
      },
      encoding: "utf8"
    }
  );
  if (databaseReadiness.status !== 0) {
    throw new Error(
      `Restored database readiness failed\nSTDOUT:\n${databaseReadiness.stdout}\nSTDERR:\n${databaseReadiness.stderr}`
    );
  }

  const port = Number(process.env.GETDONE_RESTORE_BOOT_PORT || (32_000 + (process.pid % 1_000)));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("GETDONE_RESTORE_BOOT_PORT must be a valid non-privileged TCP port");
  }

  const appEnv = {
    ...process.env,
    NODE_ENV: "production",
    NEXT_PUBLIC_APP_ENV: "staging",
    GETDONE_RUNTIME_ENV: "staging",
    GETDONE_DATA_MODE: "authoritative",
    GETDONE_PROCESS_ROLE: "web",
    DATABASE_URL: targetConnectionString,
    GETDONE_DB_RUNTIME_ROLE: "getdone_tenant_runtime",
    GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false",
    GETDONE_BACKUP_MAX_AGE_HOURS: "24",
    GETDONE_WEBAUTHN_RP_ID: "localhost",
    GETDONE_WEBAUTHN_ORIGINS: `http://localhost:${port}`,
    GETDONE_AUTH_COOKIE_SECURE: "false"
  };

  if (process.env.GETDONE_RESTORE_SKIP_BUILD !== "true") {
    const build = spawnSync("npm", ["run", "build"], {
      cwd: process.cwd(),
      env: appEnv,
      encoding: "utf8"
    });
    if (build.status !== 0) {
      throw new Error(
        `Restored application build failed\nSTDOUT:\n${build.stdout}\nSTDERR:\n${build.stderr}`
      );
    }
  }
  if (!fs.existsSync(path.join(process.cwd(), ".next", "BUILD_ID"))) {
    throw new Error("Application bootability requires a completed Next.js production build");
  }

  appProcess = spawn(
    "npm",
    ["run", "start", "--", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: process.cwd(),
      env: appEnv,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let appOutput = "";
  appProcess.stdout?.on("data", (chunk) => { appOutput += String(chunk); });
  appProcess.stderr?.on("data", (chunk) => { appOutput += String(chunk); });

  let health;
  try {
    health = await waitForHealth(
      `http://127.0.0.1:${port}/api/control/health`,
      appProcess
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nAPP OUTPUT:\n${appOutput.slice(-8000)}`
    );
  } finally {
    await stopChild(appProcess);
    appProcess = null;
  }

  console.log(JSON.stringify({
    ok: true,
    verifier: "staging-backup-restore",
    isolatedDatabase: targetDatabase,
    keptDatabase: keepDatabase,
    migrationVersion: expectedMigration,
    backupSha256: manifest.backupSha256,
    snapshotHashes: restoredHashes,
    invariants,
    audit: {
      ok: auditResult.ok,
      ledgerCount: auditResult.ledgerCount,
      verifiedEvents: auditResult.verifiedEvents
    },
    databaseReadiness: JSON.parse(databaseReadiness.stdout),
    applicationBootability: {
      status: "verified",
      healthStatus: health.data.status,
      persistenceConnected: health.data.persistenceConnected,
      authConnected: health.data.authConnected
    }
  }, null, 2));
} finally {
  if (appProcess) await stopChild(appProcess);
  if (targetPool) await targetPool.end();
  if (created && !keepDatabase) {
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(targetDatabase)} WITH (FORCE)`);
    } catch {}
  }
  await adminPool.end();
}
