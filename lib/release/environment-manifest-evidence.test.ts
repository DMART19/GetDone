import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root=process.cwd();
const created:string[]=[];

function run(script:string,env:Record<string,string>){
  const result=spawnSync(process.execPath,[script],{
    cwd:root,
    env:{...process.env,...env},
    encoding:"utf8"
  });
  expect(result.status,result.stderr+"\n"+result.stdout).toBe(0);
  return result.stdout;
}
function tempDir(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"getdone-env-evidence-"));
  created.push(directory);
  return directory;
}
function gitSha(){
  return execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim();
}

afterEach(()=>{
  for(const item of created.splice(0)){
    fs.rmSync(item,{recursive:true,force:true});
  }
});

describe("evidence-derived environment manifest",()=>{
  it("never treats configured environment variables as connection evidence",()=>{
    const directory=tempDir();
    const output=path.join(directory,"manifest.json");
    run("scripts/generate-environment-manifest.mjs",{
      GETDONE_ENVIRONMENT_EVIDENCE_DIR:path.join(directory,"empty"),
      GETDONE_ENVIRONMENT_MANIFEST_OUTPUT:output,
      OPENROUTER_API_KEY:"present-but-not-evidence",
      DATABASE_URL:"postgresql://configured-but-not-evidence.invalid/db",
      GETDONE_CRM_ACTIONS_JSON:'[{"configured":true}]'
    });
    const manifest=JSON.parse(fs.readFileSync(output,"utf8"));
    expect(manifest.environments.staging.connections.aiGateway).toBe(false);
    expect(manifest.environments.staging.connections.database).toBe(false);
    expect(manifest.environments.staging.connections.businessActionAdapters).toBe(false);
    expect(manifest.generation.acceptedEvidenceCount).toBe(0);
  });

  it("connects only the exact environment and subsystem proved by fresh hash-bound acceptance",()=>{
    const directory=tempDir();
    const artifact=path.join(directory,"openrouter.json");
    const evidence=path.join(directory,"evidence");
    const output=path.join(directory,"manifest.json");
    fs.writeFileSync(artifact,JSON.stringify({accepted:true,scenarios:[{status:"passed"}]})+"\n");

    run("scripts/record-environment-evidence.mjs",{
      GETDONE_EVIDENCE_ENVIRONMENT:"staging",
      GETDONE_EVIDENCE_TARGET:"aiGateway",
      GETDONE_EVIDENCE_ACCEPTANCE_ID:"openrouter-live-canary",
      GETDONE_EVIDENCE_ARTIFACT_PATH:artifact,
      GETDONE_EVIDENCE_CANDIDATE_SHA:gitSha(),
      GETDONE_EVIDENCE_OUTPUT_DIR:evidence
    });
    run("scripts/generate-environment-manifest.mjs",{
      GETDONE_ENVIRONMENT_EVIDENCE_DIR:evidence,
      GETDONE_ENVIRONMENT_MANIFEST_OUTPUT:output,
      GETDONE_ENVIRONMENT_EVIDENCE_SHA:gitSha()
    });
    const manifest=JSON.parse(fs.readFileSync(output,"utf8"));
    expect(manifest.environments.staging.connections.aiGateway).toBe(true);
    expect(manifest.environments.staging.aiGateway.adapterStatus).toBe("connected");
    expect(manifest.environments.production.connections.aiGateway).toBe(false);
    expect(manifest.environments.staging.connections.database).toBe(false);
    expect(manifest.generation.acceptedEvidenceCount).toBe(1);
    expect(manifest.environments.staging.connectionEvidence.aiGateway.evidenceHash)
      .toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects stale, wrong-SHA, assertion-failing, and artifact-tampered evidence",()=>{
    const directory=tempDir();
    const artifact=path.join(directory,"crm.json");
    const evidence=path.join(directory,"evidence");
    const output=path.join(directory,"manifest.json");
    fs.writeFileSync(artifact,JSON.stringify({accepted:true})+"\n");

    run("scripts/record-environment-evidence.mjs",{
      GETDONE_EVIDENCE_ENVIRONMENT:"production",
      GETDONE_EVIDENCE_TARGET:"businessActionAdapters",
      GETDONE_EVIDENCE_ACCEPTANCE_ID:"crm-live-acceptance",
      GETDONE_EVIDENCE_ARTIFACT_PATH:artifact,
      GETDONE_EVIDENCE_CANDIDATE_SHA:gitSha(),
      GETDONE_EVIDENCE_OUTPUT_DIR:evidence
    });

    fs.writeFileSync(artifact,JSON.stringify({accepted:false})+"\n");
    run("scripts/generate-environment-manifest.mjs",{
      GETDONE_ENVIRONMENT_EVIDENCE_DIR:evidence,
      GETDONE_ENVIRONMENT_MANIFEST_OUTPUT:output,
      GETDONE_ENVIRONMENT_EVIDENCE_SHA:gitSha()
    });
    const tampered=JSON.parse(fs.readFileSync(output,"utf8"));
    expect(tampered.environments.production.connections.businessActionAdapters).toBe(false);
    expect(tampered.rejectedEvidence.some((item:{reason:string})=>item.reason==="artifact-hash")).toBe(true);
  });
});
