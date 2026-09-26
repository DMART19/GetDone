import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { sha256Hex } from "./postgres-backup-integrity.mjs";

const root = process.cwd();
const baseUrl = process.env.DATABASE_URL?.trim();
if (!baseUrl) throw new Error("DATABASE_URL is required");

function run(command, args, options = {}) {
  const result = spawnSync(command,args,{
    cwd:options.cwd ?? root,
    env:{...process.env,...(options.env ?? {})},
    encoding:"utf8",
    maxBuffer:24*1024*1024
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result.stdout.trim();
}
function quoteIdentifier(value) {
  return '"' + value.replaceAll('"','""') + '"';
}
function dbUrl(name) {
  const url = new URL(baseUrl);
  url.pathname = "/" + name;
  return url.toString();
}

const policy = JSON.parse(fs.readFileSync(
  path.join(root,"config","zero-downtime-migration-policy.json"),"utf8"
));
const transition = (policy.migrations ?? [])
  .filter((item)=>item.transitionSchema === true)
  .sort((a,b)=>String(a.version).localeCompare(String(b.version)))
  .at(-1);
if (!transition) throw new Error("Zero-downtime policy has no transition migration");

const suffix = `${process.pid}_${Date.now()}`;
const oldDbName = `getdone_roll_old_${suffix}`;
const newDbName = `getdone_roll_new_${suffix}`;
const worktree = path.join(os.tmpdir(),`getdone-previous-${suffix}`);
const evidenceDir = path.join(root,"test-results","rolling-migration");
const oldEvidencePath = path.join(evidenceDir,"old-code-new-schema.json");
const newEvidencePath = path.join(evidenceDir,"new-code-transition-schema.json");
fs.mkdirSync(evidenceDir,{recursive:true});

const admin = new pg.Pool({
  connectionString:baseUrl,
  max:2,
  application_name:"getdone-rolling-migration-acceptance",
  ssl:process.env.GETDONE_DB_SSL === "false" ? false : {rejectUnauthorized:true}
});

try {
  for (const name of [oldDbName,newDbName]) {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
    run(process.execPath,["scripts/migrate-postgres.mjs"],{
      env:{
        DATABASE_URL:dbUrl(name),
        GETDONE_DB_SSL:process.env.GETDONE_DB_SSL ?? "false",
        GETDONE_MIGRATION_TARGET:transition.version
      }
    });
  }

  run("git",["worktree","add","--detach",worktree,policy.previousReleaseRef]);
  fs.mkdirSync(path.join(worktree,"lib","migrations"),{recursive:true});
  fs.copyFileSync(
    path.join(root,"lib","migrations","authority-rolling-probe.integration.test.ts"),
    path.join(worktree,"lib","migrations","authority-rolling-probe.integration.test.ts")
  );
  run("npm",["ci","--ignore-scripts","--no-audit","--no-fund"],{cwd:worktree});
  run("npx",["vitest","run","lib/migrations/authority-rolling-probe.integration.test.ts"],{
    cwd:worktree,
    env:{
      DATABASE_URL:dbUrl(oldDbName),
      GETDONE_DB_SSL:process.env.GETDONE_DB_SSL ?? "false",
      GETDONE_ROLLING_COMPATIBILITY:"true",
      GETDONE_ROLLING_CODE_LABEL:"previous-release",
      GETDONE_ROLLING_EVIDENCE_PATH:oldEvidencePath
    }
  });

  run("npx",["vitest","run","lib/migrations/authority-rolling-probe.integration.test.ts"],{
    env:{
      DATABASE_URL:dbUrl(newDbName),
      GETDONE_DB_SSL:process.env.GETDONE_DB_SSL ?? "false",
      GETDONE_ROLLING_COMPATIBILITY:"true",
      GETDONE_ROLLING_CODE_LABEL:"candidate-release",
      GETDONE_ROLLING_EVIDENCE_PATH:newEvidencePath
    }
  });

  const oldEvidence = JSON.parse(fs.readFileSync(oldEvidencePath,"utf8"));
  const newEvidence = JSON.parse(fs.readFileSync(newEvidencePath,"utf8"));
  if (oldEvidence.semanticHash !== newEvidence.semanticHash) {
    throw new Error(
      `Rolling compatibility semantic drift: previous=${oldEvidence.semanticHash} candidate=${newEvidence.semanticHash}`
    );
  }
  if (
    oldEvidence.semantics?.migrationVersion !== transition.version
    || newEvidence.semantics?.migrationVersion !== transition.version
  ) {
    throw new Error("Rolling compatibility probes did not execute against transition schema");
  }

  const verifiedAt = new Date().toISOString();
  const payload = {
    schemaVersion:"1.0.0",
    releaseId:transition.releaseId,
    previousRef:policy.previousReleaseRef,
    transitionMigration:transition.version,
    verifiedAt,
    oldOnNewHash:oldEvidence.semanticHash,
    newOnTransitionHash:newEvidence.semanticHash,
    authoritySemanticsEqual:true
  };
  const evidenceHash = sha256Hex(payload);
  const evidencePool = new pg.Pool({
    connectionString:dbUrl(newDbName),
    max:1,
    application_name:"getdone-rolling-migration-evidence",
    ssl:process.env.GETDONE_DB_SSL === "false" ? false : {rejectUnauthorized:true}
  });
  try {
    await evidencePool.query(
      `INSERT INTO migration_compatibility_evidence
        (id,release_id,previous_ref,transition_migration,verified_at,
         old_on_new_hash,new_on_transition_hash,evidence_hash,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT(release_id,transition_migration) DO UPDATE
       SET previous_ref=excluded.previous_ref,
           verified_at=excluded.verified_at,
           old_on_new_hash=excluded.old_on_new_hash,
           new_on_transition_hash=excluded.new_on_transition_hash,
           evidence_hash=excluded.evidence_hash,
           payload=excluded.payload`,
      [
        `migration-compatibility:${transition.releaseId}`,
        transition.releaseId,
        policy.previousReleaseRef,
        transition.version,
        verifiedAt,
        oldEvidence.semanticHash,
        newEvidence.semanticHash,
        evidenceHash,
        JSON.stringify(payload)
      ]
    );
  } finally {
    await evidencePool.end();
  }

  fs.writeFileSync(
    path.join(evidenceDir,"summary.json"),
    JSON.stringify({...payload,evidenceHash},null,2)+"\n"
  );
  console.log(JSON.stringify({ok:true,...payload,evidenceHash},null,2));
} finally {
  try { run("git",["worktree","remove","--force",worktree]); } catch {}
  for (const name of [oldDbName,newDbName]) {
    try { await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`); } catch {}
  }
  await admin.end();
}
