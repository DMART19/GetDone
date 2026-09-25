import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key)=>[key,canonicalize(value[key])])
    );
  }
  return value;
}
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}
function gitSha() {
  return execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim();
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file,"utf8"));
}
function nested(value, dotted) {
  return dotted.split(".").reduce((current,key)=>{
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    return current[key];
  }, value);
}
function listJsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const output=[];
  for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    const full=path.join(directory,entry.name);
    if (entry.isDirectory()) output.push(...listJsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".json")) output.push(full);
  }
  return output.sort();
}
function evidenceHash(receipt) {
  const { evidenceHash: omitted, ...base } = receipt;
  void omitted;
  return sha256(JSON.stringify(canonicalize(base)));
}
function status(connected) {
  return connected ? "connected" : "not-connected";
}

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const templatePath = path.resolve(
  process.env.GETDONE_ENVIRONMENT_TEMPLATE_PATH
    || path.join(root,"release","environment-manifest.template.json")
);
const policyPath = path.resolve(
  process.env.GETDONE_ENVIRONMENT_EVIDENCE_POLICY_PATH
    || path.join(root,"config","environment-evidence-policy.json")
);
const evidenceDir = path.resolve(
  process.env.GETDONE_ENVIRONMENT_EVIDENCE_DIR
    || path.join(root,"release","environment-evidence")
);
const outputPath = path.resolve(
  process.env.GETDONE_ENVIRONMENT_MANIFEST_OUTPUT
    || path.join(root,"release","environment-manifest.json")
);
const candidateSha = (
  process.env.GETDONE_ENVIRONMENT_EVIDENCE_SHA?.trim() || gitSha()
).toLowerCase();
if (!/^[a-f0-9]{40}$/.test(candidateSha)) {
  throw new Error("Environment evidence candidate SHA must be an exact 40-character Git SHA");
}
const nowMs = process.env.GETDONE_ENVIRONMENT_EVIDENCE_NOW
  ? Date.parse(process.env.GETDONE_ENVIRONMENT_EVIDENCE_NOW)
  : Date.now();
if (!Number.isFinite(nowMs)) throw new Error("Environment evidence evaluation time is invalid");

const template=readJson(templatePath);
const policy=readJson(policyPath);
if (template.manifestSchemaVersion !== policy.manifestSchemaVersion) {
  throw new Error("Environment manifest template/policy schema version drift");
}

const accepted = new Map();
const rejected = [];
for (const file of listJsonFiles(evidenceDir)) {
  let receipt;
  try { receipt=readJson(file); } catch {
    rejected.push({file:path.relative(root,file),reason:"invalid-json"});
    continue;
  }
  const targetPolicy=policy.targets?.[receipt.target];
  const acceptance=policy.acceptances?.[receipt.acceptanceId];
  const baseValid = (
    receipt.schemaVersion === policy.evidenceSchemaVersion
    && ["development","staging","production"].includes(receipt.environment)
    && targetPolicy
    && Array.isArray(targetPolicy.acceptanceIds)
    && targetPolicy.acceptanceIds.includes(receipt.acceptanceId)
    && acceptance
    && receipt.candidateSha === candidateSha
    && /^[a-f0-9]{64}$/.test(receipt.sourceArtifactSha256 ?? "")
    && receipt.evidenceHash === evidenceHash(receipt)
  );
  if (!baseValid) {
    rejected.push({file:path.relative(root,file),reason:"receipt-contract"});
    continue;
  }
  const observed=Date.parse(receipt.observedAt);
  const expires=Date.parse(receipt.expiresAt);
  if (
    !Number.isFinite(observed)
    || !Number.isFinite(expires)
    || observed > nowMs
    || expires <= nowMs
    || expires <= observed
  ) {
    rejected.push({file:path.relative(root,file),reason:"stale-or-invalid-time"});
    continue;
  }
  const artifactPath=path.resolve(root,receipt.sourceArtifactPath);
  if (!fs.existsSync(artifactPath) || fileSha256(artifactPath) !== receipt.sourceArtifactSha256) {
    rejected.push({file:path.relative(root,file),reason:"artifact-hash"});
    continue;
  }
  let artifact;
  try { artifact=readJson(artifactPath); } catch {
    rejected.push({file:path.relative(root,file),reason:"artifact-json"});
    continue;
  }
  const assertion=acceptance.artifactAssertion;
  if (!assertion || nested(artifact,assertion.path) !== assertion.equals) {
    rejected.push({file:path.relative(root,file),reason:"artifact-assertion"});
    continue;
  }

  const key=`${receipt.environment}:${receipt.target}`;
  const previous=accepted.get(key);
  if (!previous || Date.parse(receipt.observedAt) > Date.parse(previous.observedAt)) {
    accepted.set(key,{...receipt,evidenceFile:path.relative(root,file)});
  }
}

const manifest=structuredClone(template);
manifest.generation={
  ...manifest.generation,
  mode:"acceptance-evidence-derived",
  policyVersion:policy.policyVersion,
  candidateSha,
  acceptedEvidenceCount:accepted.size,
  rejectedEvidenceCount:rejected.length
};

for (const [name,state] of Object.entries(manifest.environments)) {
  const connections={};
  const evidence={};
  for (const target of Object.keys(policy.targets)) {
    if (target === "deployment") continue;
    const receipt=accepted.get(`${name}:${target}`);
    connections[target]=Boolean(receipt);
    if (receipt) {
      evidence[target]={
        acceptanceId:receipt.acceptanceId,
        observedAt:receipt.observedAt,
        expiresAt:receipt.expiresAt,
        candidateSha:receipt.candidateSha,
        sourceArtifactSha256:receipt.sourceArtifactSha256,
        evidenceHash:receipt.evidenceHash
      };
    }
  }
  state.connections=connections;
  state.connectionEvidence=evidence;

  const deploymentReceipt=accepted.get(`${name}:deployment`);
  state.deployment={
    ...(state.deployment ?? {}),
    status:deploymentReceipt ? "connected" : (name === "development" ? "local-development" : "not-connected")
  };
  if (deploymentReceipt) {
    state.deployment.evidence={
      acceptanceId:deploymentReceipt.acceptanceId,
      observedAt:deploymentReceipt.observedAt,
      expiresAt:deploymentReceipt.expiresAt,
      candidateSha:deploymentReceipt.candidateSha,
      evidenceHash:deploymentReceipt.evidenceHash
    };
  }

  state.productionReady = name === "production"
    && Boolean(deploymentReceipt)
    && Object.values(connections).every(Boolean);

  state.voice.adapterStatus=status(connections.voiceAdapter);
  state.aiGateway.adapterStatus=status(connections.aiGateway);
  state.integrations.adapterStatus=status(connections.businessIntegrationAdapters);

  state.execution.durableJobStoreStatus=status(connections.durableJobEngine);
  state.execution.businessActionAdapterStatus=status(connections.businessActionAdapters);
  state.execution.softwareDeploymentStatus=status(connections.softwareDeploymentExecutor);
  state.execution.liveJobExecutionBridgeStoreStatus=status(connections.controlApiPersistence);
  state.execution.persistentWorkerServiceStatus=status(connections.durableJobEngine);

  state.resourceFabric.storageRuntimeStatus=status(connections.storageFabricRuntime);
  state.resourceFabric.failoverRuntimeStatus=status(connections.resilienceFailoverRuntime);
  state.resourceFabric.secondProviderStatus=status(connections.secondResourceProvider);
  state.resourceFabric.partnerPoolRuntimeStatus=status(connections.partnerPoolRuntime);

  state.controlApi.applicationAdapterStatus=status(connections.controlApiPersistence);
  state.controlApi.persistenceStatus=status(connections.controlApiPersistence);
  state.database.adapterStatus=status(connections.database);
  state.nodeAgent.authenticatedAgentTransportStatus=status(connections.resourceAgent);
  state.nodeAgent.productionReady=Boolean(connections.resourceAgent);
}

manifest.rejectedEvidence=rejected;
const rendered=JSON.stringify(manifest,null,2)+"\n";

if (checkOnly) {
  if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath,"utf8") !== rendered) {
    console.error("Environment manifest is stale. Run npm run environment:generate.");
    process.exit(1);
  }
} else {
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});
  fs.writeFileSync(outputPath,rendered);
}
console.log(JSON.stringify({
  ok:true,
  candidateSha,
  acceptedEvidenceCount:accepted.size,
  rejectedEvidenceCount:rejected.length,
  outputPath:path.relative(root,outputPath)
},null,2));
