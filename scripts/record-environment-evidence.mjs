import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root=process.cwd();
function required(name){
  const value=process.env[name]?.trim();
  if(!value) throw new Error(`${name} is required`);
  return value;
}
function canonicalize(value){
  if(Array.isArray(value)) return value.map(canonicalize);
  if(value && typeof value==="object"){
    return Object.fromEntries(Object.keys(value).sort().map((key)=>[key,canonicalize(value[key])]));
  }
  return value;
}
function sha256(value){return crypto.createHash("sha256").update(value).digest("hex");}
function gitSha(){return execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim();}
function hashReceipt(receipt){return sha256(JSON.stringify(canonicalize(receipt)));}

const policy=JSON.parse(fs.readFileSync(path.join(root,"config","environment-evidence-policy.json"),"utf8"));
const environment=required("GETDONE_EVIDENCE_ENVIRONMENT");
const target=required("GETDONE_EVIDENCE_TARGET");
const acceptanceId=required("GETDONE_EVIDENCE_ACCEPTANCE_ID");
const sourceArtifactPath=required("GETDONE_EVIDENCE_ARTIFACT_PATH");
const candidateSha=(process.env.GETDONE_EVIDENCE_CANDIDATE_SHA?.trim() || process.env.GITHUB_SHA?.trim() || gitSha()).toLowerCase();
if(!["development","staging","production"].includes(environment)) throw new Error("Invalid evidence environment");
if(!policy.targets?.[target]?.acceptanceIds?.includes(acceptanceId)) throw new Error("Acceptance ID is not allowed for target");
if(!policy.acceptances?.[acceptanceId]) throw new Error("Acceptance profile is not defined");
if(!/^[a-f0-9]{40}$/.test(candidateSha)) throw new Error("Candidate SHA must be exact");
const artifactAbsolute=path.resolve(root,sourceArtifactPath);
if(!fs.existsSync(artifactAbsolute)) throw new Error("Evidence source artifact does not exist");
JSON.parse(fs.readFileSync(artifactAbsolute,"utf8"));

const observedAt=process.env.GETDONE_EVIDENCE_OBSERVED_AT?.trim() || new Date().toISOString();
const observedMs=Date.parse(observedAt);
if(!Number.isFinite(observedMs)) throw new Error("Evidence observed time is invalid");
const maxAgeHours=Number(process.env.GETDONE_EVIDENCE_MAX_AGE_HOURS || policy.defaultMaxAgeHours);
if(!Number.isFinite(maxAgeHours) || maxAgeHours<=0) throw new Error("Evidence max age must be positive");
const expiresAt=new Date(observedMs+maxAgeHours*60*60_000).toISOString();
const base={
  schemaVersion:policy.evidenceSchemaVersion,
  environment,
  target,
  acceptanceId,
  candidateSha,
  observedAt:new Date(observedMs).toISOString(),
  expiresAt,
  sourceArtifactPath:path.relative(root,artifactAbsolute),
  sourceArtifactSha256:sha256(fs.readFileSync(artifactAbsolute)),
  workflowName:process.env.GITHUB_WORKFLOW?.trim() || undefined,
  workflowRunId:process.env.GITHUB_RUN_ID?.trim() || undefined
};
const receipt={...base,evidenceHash:hashReceipt(base)};
const outputDir=path.resolve(root,process.env.GETDONE_EVIDENCE_OUTPUT_DIR?.trim() || "test-results/environment-evidence");
fs.mkdirSync(outputDir,{recursive:true});
const output=path.join(outputDir,`${environment}-${target}-${acceptanceId}.json`);
fs.writeFileSync(output,JSON.stringify(receipt,null,2)+"\n");
console.log(JSON.stringify(receipt,null,2));
