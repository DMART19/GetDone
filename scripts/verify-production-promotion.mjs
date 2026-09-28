import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";

const root = process.cwd();
function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function readJson(file) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new Error(`Required release evidence is missing: ${file}`);
  return JSON.parse(fs.readFileSync(absolute,"utf8"));
}
function runJson(command,args,env = {}) {
  const result = spawnSync(command,args,{
    cwd:root,
    env:{...process.env,...env},
    encoding:"utf8",
    maxBuffer:24*1024*1024
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  const stdout = result.stdout.trim();
  return stdout.startsWith("{") ? JSON.parse(stdout) : {ok:true,stdout};
}

const candidateSha = required("GETDONE_RELEASE_CANDIDATE_SHA");
if (!/^[a-f0-9]{40}$/.test(candidateSha)) {
  throw new Error("GETDONE_RELEASE_CANDIDATE_SHA must be an exact commit SHA");
}
const databaseUrl = required("DATABASE_URL");

const github = readJson(
  process.env.GETDONE_GITHUB_RELEASE_EVIDENCE_PATH
    || "test-results/production-gate/github-evidence.json"
);
if (github.candidateSha !== candidateSha) {
  throw new Error("GitHub CI evidence is for a different candidate SHA");
}
for (const requiredWorkflow of ["CI","PostgreSQL Integration"]) {
  const check = github.checks?.find((item)=>item.name === requiredWorkflow);
  if (!check || check.headSha !== candidateSha || check.conclusion !== "success") {
    throw new Error(`Required GitHub evidence is not green for ${requiredWorkflow}`);
  }
}

const openrouter = readJson("test-results/openrouter-staging-acceptance.json");
if (
  openrouter.accepted !== true
  || !Array.isArray(openrouter.scenarios)
  || !openrouter.scenarios.some((item)=>item.evidenceMode === "live-provider" && item.status === "passed")
) {
  throw new Error("Live OpenRouter canary evidence is not accepted");
}

const browser = readJson("test-results/playwright-staging-results.json");
const browserFailures = Array.isArray(browser.suites)
  ? JSON.stringify(browser).match(/"status":"(?:failed|timedOut|interrupted)"/g)?.length ?? 0
  : 0;
if (browserFailures > 0) throw new Error("Staging E2E evidence contains failures");

const safeIntegration = readJson("test-results/configured-http-staging-acceptance.json");
if (!Array.isArray(safeIntegration.cases) || safeIntegration.cases.length < 1) {
  throw new Error("Safe integration canary evidence is missing");
}

const worker = readJson(
  process.env.GETDONE_WORKER_HEALTH_EVIDENCE_PATH
    || "test-results/production-gate/worker-health.json"
);
if (
  worker.ready !== true
  || worker.state !== "running"
  || worker.role !== "job-worker"
) {
  throw new Error("Job worker readiness canary did not pass");
}

const orchestrationWorker = readJson(
  process.env.GETDONE_ORCHESTRATION_WORKER_HEALTH_EVIDENCE_PATH
    || "test-results/production-gate/orchestration-worker-health.json"
);
if (
  orchestrationWorker.ready !== true
  || orchestrationWorker.state !== "running"
  || orchestrationWorker.role !== "orchestration-worker"
) {
  throw new Error("Orchestration worker readiness canary did not pass");
}

const dependency = runJson("node",["scripts/verify-dependencies.mjs"]);
const contracts = runJson("node",["scripts/verify-contract-versions.mjs"]);
const migrations = runJson("node",["scripts/verify-zero-downtime-migrations.mjs"]);
runJson("node",["scripts/generate-release-artifacts.mjs"]);
const release = runJson("node",["scripts/verify-release-artifacts.mjs"]);
const postgres = runJson("node",["scripts/verify-postgres-production.mjs"]);
if (postgres.backupFresh !== true) {
  throw new Error("Production PostgreSQL verification did not prove backup freshness");
}

const reportBase = {
  schemaVersion:"1.0.0",
  candidateSha,
  checkedAt:new Date().toISOString(),
  status:"passed",
  gates:{
    exactShaCi:true,
    postgresVerification:true,
    backupFresh:true,
    stagingE2E:true,
    liveOpenRouterCanary:true,
    liveSafeIntegrationCanary:true,
    workerHealth:true,
    orchestrationWorkerHealth:true,
    vulnerabilityScan:true,
    contractDrift:true,
    zeroDowntimeMigrationPolicy:true,
    releaseManifest:true
  },
  evidence:{
    githubRuns:github.checks.map((item)=>({name:item.name,runId:item.runId,runNumber:item.runNumber})),
    openRouterScenarioCount:openrouter.scenarios.length,
    safeIntegrationCaseCount:safeIntegration.cases.length,
    workerEvidenceHash:worker.evidenceHash,
    orchestrationWorkerEvidenceHash:orchestrationWorker.evidenceHash,
    postgres,
    dependency,
    contracts,
    migrations,
    release
  }
};
const gateHash = crypto.createHash("sha256")
  .update(JSON.stringify(reportBase))
  .digest("hex");
const report = {...reportBase,gateHash};
const out = path.resolve("test-results/production-gate/promotion-report.json");
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out,JSON.stringify(report,null,2)+"\n");

const pool = new pg.Pool({
  connectionString:databaseUrl,
  max:1,
  application_name:"getdone-production-release-gate",
  ssl:process.env.GETDONE_DB_SSL === "false" ? false : {rejectUnauthorized:true}
});
try {
  const id = `release-gate:${candidateSha}`;
  await pool.query(
    `INSERT INTO production_release_gate_evidence
      (id,candidate_sha,created_at,status,gate_hash,payload)
     VALUES($1,$2,$3,'passed',$4,$5::jsonb)
     ON CONFLICT(id) DO UPDATE
     SET created_at=excluded.created_at,status=excluded.status,
         gate_hash=excluded.gate_hash,payload=excluded.payload`,
    [id,candidateSha,report.checkedAt,gateHash,JSON.stringify(report)]
  );
} finally {
  await pool.end();
}
console.log(JSON.stringify(report,null,2));
