import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const role = (
  process.env.GETDONE_WORKER_HEALTH_ROLE
  || process.env.GETDONE_PROCESS_ROLE
  || "job-worker"
).trim();

if (!["job-worker","orchestration-worker"].includes(role)) {
  throw new Error("Worker health canary role must be job-worker or orchestration-worker");
}

const orchestration = role === "orchestration-worker";
const portVariable = orchestration
  ? "GETDONE_ORCHESTRATION_WORKER_HEALTH_PORT"
  : "GETDONE_JOB_WORKER_HEALTH_PORT";
const port = Number(process.env[portVariable] || (orchestration ? "3002" : "3001"));
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error(`${portVariable} must be a valid non-privileged port`);
}

const command = orchestration ? "start:orchestration-worker" : "start:worker";
const workerIdVariable = orchestration
  ? "GETDONE_ORCHESTRATION_WORKER_ID"
  : "GETDONE_JOB_WORKER_ID";
const healthHostVariable = orchestration
  ? "GETDONE_ORCHESTRATION_WORKER_HEALTH_HOST"
  : "GETDONE_JOB_WORKER_HEALTH_HOST";

const child = spawn("npm",["run",command],{
  cwd:process.cwd(),
  env:{
    ...process.env,
    GETDONE_PROCESS_ROLE:role,
    [workerIdVariable]:process.env[workerIdVariable]
      || (orchestration ? "release-gate-orchestration-worker" : "release-gate-job-worker"),
    [healthHostVariable]:"127.0.0.1",
    [portVariable]:String(port)
  },
  stdio:["ignore","pipe","pipe"]
});
let output="";
child.stdout?.on("data",(chunk)=>{output += String(chunk);});
child.stderr?.on("data",(chunk)=>{output += String(chunk);});

async function stop() {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve)=>child.once("exit",resolve)),
    new Promise((resolve)=>setTimeout(resolve,5000))
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

try {
  let health;
  for (let attempt=0; attempt<120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `${role} exited before readiness with code ${child.exitCode}\n${output.slice(-8000)}`
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`,{
        headers:{"cache-control":"no-store"}
      });
      const body = await response.json();
      if (response.ok && body?.ok === true && body?.state === "running") {
        health = body;
        break;
      }
    } catch {}
    await new Promise((resolve)=>setTimeout(resolve,500));
  }
  if (!health) {
    throw new Error(`${role} did not become ready\n${output.slice(-8000)}`);
  }

  const evidenceBase = {
    schemaVersion:"1.1.0",
    checkedAt:new Date().toISOString(),
    ready:true,
    role,
    service:health.service,
    state:health.state,
    workerId:health.workerId,
    workerStatus:health.workerStatus
  };
  const evidence = {
    ...evidenceBase,
    evidenceHash:crypto.createHash("sha256").update(JSON.stringify(evidenceBase)).digest("hex")
  };
  const defaultEvidencePath = orchestration
    ? "test-results/production-gate/orchestration-worker-health.json"
    : "test-results/production-gate/worker-health.json";
  const out = path.resolve(
    process.env.GETDONE_WORKER_HEALTH_EVIDENCE_PATH?.trim()
      || defaultEvidencePath
  );
  fs.mkdirSync(path.dirname(out),{recursive:true});
  fs.writeFileSync(out,JSON.stringify(evidence,null,2)+"\n");
  console.log(JSON.stringify(evidence,null,2));
} finally {
  await stop();
}
