import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { postgresTlsConnection } from "../lib/persistence/postgres/tls.ts";
import { sha256Hex } from "./postgres-backup-integrity.mjs";

const baseConnectionString = process.env.DATABASE_URL?.trim();
if (!baseConnectionString) throw new Error("DATABASE_URL is required");

function quoteIdentifier(value) {
  return '"' + value.replaceAll('"', '""') + '"';
}

function databaseUrl(name) {
  const url = new URL(baseConnectionString);
  url.pathname = "/" + name;
  return url.toString();
}

function run(script, env, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(
      `${script} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
  return result.stdout.trim();
}

const suffix = `${process.pid}_${Date.now()}`;
const sourceDatabase = `getdone_backup_source_${suffix}`;
const restoreDatabase = `getdone_restore_verify_${suffix}`;
const backupFile = path.join(os.tmpdir(), `getdone-backup-${suffix}.dump`);
const manifestFile = `${backupFile}.manifest.json`;

let sourceCreated = false;
const admin = new pg.Pool({
  ...postgresTlsConnection(baseConnectionString,process.env),
  max: 2,
  application_name: "getdone-backup-restore-test-admin"
});

try {
  // Never delete pre-existing databases, even those with a test prefix.
  await admin.query(`CREATE DATABASE ${quoteIdentifier(sourceDatabase)}`);
  sourceCreated = true;

  const sourceUrl = databaseUrl(sourceDatabase);
  run("scripts/migrate-postgres.mjs", {
    DATABASE_URL: sourceUrl,
    GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false"
  });

  const source = new pg.Pool({
    ...postgresTlsConnection(sourceUrl,process.env),
    max: 4,
    application_name: "getdone-backup-restore-source"
  });
  try {
    const at = "2026-09-25T05:00:00.000Z";
    const expiresAt = "2027-09-25T05:00:00.000Z";
    const scope = {
      userId: "owner-restore",
      portfolioId: "portfolio-restore",
      companyId: "company-restore",
      environment: "staging"
    };

    // From 2026-10-17.1 onward health checks must prove that the dedicated
    // pre-authentication role can actually resolve an ACTIVE owner and
    // membership. A schema-only restore without these rows is not ready.
    await source.query(
      "INSERT INTO auth_users(id,status) VALUES($1,'active')", [scope.userId]
    );
    await source.query(
      "INSERT INTO organizations(id,name) VALUES($1,'Restore fixture organization')",
      ["org-restore"]
    );
    await source.query(
      "INSERT INTO companies(id,organization_id,name) VALUES($1,$2,'Restore fixture company')",
      [scope.companyId,"org-restore"]
    );
    await source.query(
      "INSERT INTO portfolios(id,organization_id,company_id,name) VALUES($1,$2,$3,'Restore fixture portfolio')",
      [scope.portfolioId,"org-restore",scope.companyId]
    );
    await source.query(
      "INSERT INTO organization_memberships(user_id,organization_id,role,status) VALUES($1,$2,'owner','active')",
      [scope.userId,"org-restore"]
    );
    await source.query(
      "INSERT INTO company_memberships(user_id,company_id,role,status) VALUES($1,$2,'owner','active')",
      [scope.userId,scope.companyId]
    );
    await source.query(
      "INSERT INTO portfolio_memberships(user_id,portfolio_id,company_id,role,status) VALUES($1,$2,$3,'owner','active')",
      [scope.userId,scope.portfolioId,scope.companyId]
    );

    const grantBase = {
      id: "grant-restore",
      status: "active",
      disposition: "AUTO",
      scope,
      planId: "plan-restore",
      planVersion: 1,
      planHash: "1".repeat(64),
      stepId: "step-restore",
      stepHash: "2".repeat(64),
      capabilityNames: ["http.request"],
      validationReceiptId: "plan-validation-restore",
      validationReceiptHash: "3".repeat(64),
      policySnapshotId: "policy-snapshot-restore",
      policySnapshotHash: "4".repeat(64),
      policyVersion: "policy-restore",
      policyEngineVersion: "1.0.0",
      policyRulesHash: "5".repeat(64),
      actor: { type: "user", id: "owner-restore" },
      issuedAt: at,
      expiresAt
    };
    const grant = { ...grantBase, grantHash: sha256Hex(grantBase) };
    await source.query(
      `INSERT INTO authorization_grants
        (id,portfolio_id,company_id,status,expires_at,grant_hash,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        grant.id,scope.portfolioId,scope.companyId,grant.status,grant.expiresAt,
        grant.grantHash,JSON.stringify(grant)
      ]
    );

    const consumptionBase = {
      id: "authorization-consumption:grant-restore",
      grantId: grant.id,
      grantHash: grant.grantHash,
      consumerType: "task",
      consumerId: "task-restore",
      scope,
      planHash: grant.planHash,
      stepHash: grant.stepHash,
      consumedAt: "2026-09-25T05:00:01.000Z"
    };
    const consumption = {
      ...consumptionBase,
      consumptionHash: sha256Hex(consumptionBase)
    };
    await source.query(
      `INSERT INTO authorization_consumptions
        (id,grant_id,consumer_type,consumer_id,consumption_hash,consumed_at,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        consumption.id,consumption.grantId,consumption.consumerType,
        consumption.consumerId,consumption.consumptionHash,
        consumption.consumedAt,JSON.stringify(consumption)
      ]
    );

    const envelopeBase = {
      id: "queue:job-restore",
      correlationId: "corr-restore",
      jobId: "job-restore",
      taskId: "task-restore",
      scope,
      authorizationConsumptionHash: consumption.consumptionHash,
      idempotencyKey: "queue-job-restore",
      scheduledAt: "2026-09-25T05:00:02.000Z",
      createdAt: "2026-09-25T05:00:02.000Z"
    };
    const envelope = { ...envelopeBase, envelopeHash: sha256Hex(envelopeBase) };
    const stateHash = sha256Hex({
      jobId: envelope.jobId,
      envelopeHash: envelope.envelopeHash,
      state: "queued",
      version: 1,
      attempt: 0,
      scheduledAt: envelope.scheduledAt
    });
    const transactionBase = {
      id: "job-tx-restore",
      operation: "enqueue",
      jobId: envelope.jobId,
      idempotencyKey: envelope.idempotencyKey,
      expectedVersion: 0,
      expectedHash: sha256Hex({ jobId: envelope.jobId, state: "absent" }),
      nextVersion: 1,
      nextHash: stateHash,
      occurredAt: envelope.createdAt
    };
    const transaction = {
      ...transactionBase,
      transactionHash: sha256Hex(transactionBase)
    };

    const jobEntity = {
      id: "job-restore",
      correlationId: "corr-restore",
      portfolioId: scope.portfolioId,
      companyId: scope.companyId,
      state: "queued",
      taskId: "task-restore",
      attempt: 0,
      version: 1,
      updatedAt: envelope.createdAt
    };
    await source.query(
      `INSERT INTO control_plane_entities
        (entity_type,id,portfolio_id,company_id,version,updated_at,payload)
       VALUES('job',$1,$2,$3,1,$4,$5::jsonb)`,
      [
        jobEntity.id,jobEntity.portfolioId,jobEntity.companyId,
        jobEntity.updatedAt,JSON.stringify(jobEntity)
      ]
    );
    await source.query(
      `INSERT INTO job_runtime_state
        (job_id,envelope,envelope_hash,runtime_state,version,state_hash,attempt,scheduled_at,updated_at)
       VALUES($1,$2::jsonb,$3,'queued',1,$4,0,$5,$6)`,
      [
        envelope.jobId,JSON.stringify(envelope),envelope.envelopeHash,
        stateHash,envelope.scheduledAt,envelope.createdAt
      ]
    );
    await source.query(
      `INSERT INTO job_runtime_transactions
        (id,job_id,operation,idempotency_key,transaction_hash,payload,occurred_at)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        transaction.id,transaction.jobId,transaction.operation,
        transaction.idempotencyKey,transaction.transactionHash,
        JSON.stringify(transaction),transaction.occurredAt
      ]
    );

    const receiptBase = {
      id: "verification-receipt-restore",
      correlationId: "corr-restore",
      requestId: "verification-request-restore",
      portfolioId: scope.portfolioId,
      companyId: scope.companyId,
      environment: "staging",
      subject: { type: "job", id: "job-restore" },
      verdict: "verified",
      strategyResults: [],
      evidenceIds: [],
      evidenceHashes: [],
      verifiedAt: "2026-09-25T05:00:03.000Z",
      expiresAt
    };
    const receipt = { ...receiptBase, receiptHash: sha256Hex(receiptBase) };
    await source.query(
      `INSERT INTO verification_receipts
        (id,portfolio_id,company_id,subject_type,subject_id,expires_at,receipt_hash,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [
        receipt.id,receipt.portfolioId,receipt.companyId,receipt.subject.type,
        receipt.subject.id,receipt.expiresAt,receipt.receiptHash,JSON.stringify(receipt)
      ]
    );

    const auditPayload = {
      id: "audit-restore",
      correlationId: "corr-restore",
      eventType: "job.queued",
      actor: { type: "system", id: "restore-test" },
      scope,
      environment: "staging",
      entityType: "job",
      entityId: "job-restore",
      provenance: "backup-restore-test",
      occurredAt: "2026-09-25T05:00:04.000Z",
      metadata: {}
    };
    const auditInsert = await source.query(
      `INSERT INTO audit_events
        (id,correlation_id,portfolio_id,company_id,entity_type,entity_id,occurred_at,payload,
         chain_sequence,previous_event_hash,event_hash)
       VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8::jsonb,1,repeat('0',64),
         getdone_audit_event_hash($3,$4,1,repeat('0',64),$1,$7,$8::jsonb)
       )
       RETURNING event_hash`,
      [
        auditPayload.id,auditPayload.correlationId,scope.portfolioId,scope.companyId,
        auditPayload.entityType,auditPayload.entityId,auditPayload.occurredAt,
        JSON.stringify(auditPayload)
      ]
    );
    await source.query(
      `INSERT INTO audit_chain_heads
        (portfolio_id,company_id,head_sequence,head_hash,event_count,updated_at)
       VALUES($1,$2,1,$3,1,$4)`,
      [
        scope.portfolioId,scope.companyId,auditInsert.rows[0].event_hash,
        auditPayload.occurredAt
      ]
    );
  } finally {
    await source.end();
  }

  const backupOutput = run("scripts/create-staging-backup.mjs", {
    GETDONE_RUNTIME_ENV: "staging",
    DATABASE_URL: sourceUrl,
    GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false",
    GETDONE_BACKUP_FILE: backupFile,
    GETDONE_BACKUP_MANIFEST: manifestFile,
    GETDONE_BACKUP_OVERWRITE: "true",
    GETDONE_BACKUP_REF: `integration:${sourceDatabase}`
  });
  const backup = JSON.parse(backupOutput);
  if (!backup.ok || !/^[a-f0-9]{64}$/.test(backup.backupSha256)) {
    throw new Error("Staging backup command did not produce verified evidence");
  }

  // A dump on its own cannot make staging production-ready. Verification
  // evidence must appear only after an independent restore and retained copy.
  const preRestoreSource = new pg.Pool({
    ...postgresTlsConnection(sourceUrl, process.env),
    max: 1, application_name: "getdone-backup-pre-restore-assertion"
  });
  try {
    const rows = await preRestoreSource.query(
      "SELECT COUNT(*)::int AS count FROM database_backup_evidence WHERE status='verified'"
    );
    if (Number(rows.rows[0]?.count) !== 0) {
      throw new Error("Backup creation incorrectly marked recovery as verified");
    }
  } finally {
    await preRestoreSource.end();
  }

  const restoreOutput = run("scripts/restore-staging-backup.mjs", {
    GETDONE_RUNTIME_ENV: "staging",
    GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false",
    GETDONE_BACKUP_FILE: backupFile,
    GETDONE_BACKUP_MANIFEST: manifestFile,
    GETDONE_RESTORE_ADMIN_DATABASE_URL: baseConnectionString,
    GETDONE_RESTORE_DATABASE_NAME: restoreDatabase,
    GETDONE_RESTORE_BOOT_PORT: String(33_000 + (process.pid % 1_000))
  });
  const restored = JSON.parse(restoreOutput);
  if (
    !restored.ok
    || restored.applicationBootability?.status !== "verified"
    || restored.audit?.ok !== true
    || restored.invariants?.ok !== true
    || restored.snapshotHashes?.composite !== backup.snapshot?.hashes?.composite
  ) {
    throw new Error(`Restore verification did not prove all invariants: ${restoreOutput}`);
  }

  // Exercise the exact two-phase private evidence gate against a disposable
  // fixture. The external-copy flag is simulated in CI; it is NOT proof of
  // durable retention of any real Supabase staging backup.
  const ceremonyResult = JSON.parse(run("scripts/backup-and-verify-staging.mjs", {
    GETDONE_RUNTIME_ENV: "staging",
    GETDONE_ALLOW_ISOLATED_RESTORE_TEST: "true",
    GETDONE_DB_SSL: process.env.GETDONE_DB_SSL || "true",
    DATABASE_URL: sourceUrl,
    GETDONE_RESTORE_ADMIN_DATABASE_URL: baseConnectionString,
    GETDONE_BACKUP_FILE: backupFile,
    GETDONE_BACKUP_MANIFEST: manifestFile,
    GETDONE_BACKUP_DURABLE_COPY_CONFIRMED: "true",
    GETDONE_BACKUP_EXTERNAL_SHA256: backup.backupSha256,
    GETDONE_BACKUP_REF: "disposable-test-restore:" + suffix,
    GETDONE_RESTORE_BOOT_PORT: String(34_000 + (process.pid % 1_000))
  }, ["--verify-existing"]));
  if (
    ceremonyResult.ok !== true
    || ceremonyResult.restoreVerified !== true
    || ceremonyResult.stagingEvidenceRecorded !== true
    || ceremonyResult.backupSha256 !== backup.backupSha256
  ) {
    throw new Error("Two-phase staging recovery evidence gate did not pass");
  }
  const evidenceSource = new pg.Pool({
    ...postgresTlsConnection(sourceUrl,process.env),
    max: 1,application_name: "getdone-backup-post-restore-evidence-test"
  });
  try {
    const recorded = await evidenceSource.query(
      "SELECT payload FROM database_backup_evidence WHERE status='verified'"
    );
    if (recorded.rows.length !== 1
      || recorded.rows[0].payload?.source !== "independent-isolated-restore"
      || recorded.rows[0].payload?.verificationHash !== backup.backupSha256
    ) {
      throw new Error("Source-side recovery evidence was missing or unverified");
    }
  } finally {
    await evidenceSource.end();
  }

  console.log(JSON.stringify({
    ok: true,
    backupSha256: backup.backupSha256,
    snapshotCompositeHash: backup.snapshot.hashes.composite,
    restoredMigration: restored.migrationVersion,
    auditIntegrity: restored.audit,
    domainInvariants: restored.invariants,
    applicationBootability: restored.applicationBootability
  }, null, 2));
} finally {
  // Restore script owns its unique target cleanup. Drop only our own
  // successfully created source fixture; never a pre-existing database.
  if (sourceCreated) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(sourceDatabase)} WITH (FORCE)`);
    } catch {}
  }
  await admin.end();
  for (const file of [backupFile, manifestFile]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {}
  }
}
