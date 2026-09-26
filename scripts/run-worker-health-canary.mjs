import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const port = Number(process.env.GETDONE_JOB_WORKER_HEALTH_PORT || "3001");
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("GETDONE_JOB_WORKER_HEALTH_PORT must be a valid non-privileged port");
}

const child = spawn("npm",["run","start:worker"],{
  cwd:process.cwd(),
  env:{
    ...process.env,
    GETDONE_PROCESS_ROLE:"job-worker",
    GETDONE_JOB_WORKER_ID:process.env.GETDONE_JOB_WORKER_ID || "release-gate-worker",
    GETDONE_JOB_WORKER_HEALTH_HOST:"127.0.0.1",
    GETDONE_JOB_WORKER_HEALTH_PORT:String(port)
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
      throw new Error(`Worker exited before readiness with code ${child.exitCode}\n${output.slice(-8000)}`);
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
  if (!health) throw new Error(`Worker did not become ready\n${output.slice(-8000)}`);

  const evidenceBase = {
    schemaVersion:"1.0.0",
    checkedAt:new Date().toISOString(),
    ready:true,
    service:health.service,
    state:health.state,
    workerId:health.workerId,
    workerStatus:health.workerStatus
  };
  const evidence = {
    ...evidenceBase,
    evidenceHash:crypto.createHash("sha256").update(JSON.stringify(evidenceBase)).digest("hex")
  };
  const out = path.resolve(
    process.env.GETDONE_WORKER_HEALTH_EVIDENCE_PATH?.trim()
      || "test-results/production-gate/worker-health.json"
  );
  fs.mkdirSync(path.dirname(out),{recursive:true});
  fs.writeFileSync(out,JSON.stringify(evidence,null,2)+"\n");
  console.log(JSON.stringify(evidence,null,2));
} finally {
  await stop();
}
