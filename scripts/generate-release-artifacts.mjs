import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const outDir = path.join(root, "release", "out");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileHash(relativePath) {
  return sha256(fs.readFileSync(path.join(root, relativePath)));
}

function extractStringConst(relativePath, name) {
  const content = read(relativePath);
  const match = content.match(new RegExp(`export const ${name} = ["']([^"']+)["']`));
  if (!match) throw new Error(`Unable to find ${name} in ${relativePath}`);
  return match[1];
}

function gitSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  }).trim();
}

function sourceVersionMap(entries) {
  return Object.fromEntries(
    Object.entries(entries).map(([name, entry]) => [
      name,
      {
        ...entry,
        sourceSha256: fileHash(entry.sourcePath)
      }
    ])
  );
}

function sourceEvidence(paths) {
  return paths.map((sourcePath) => ({
    sourcePath,
    sourceSha256: fileHash(sourcePath)
  }));
}

const registry = readJson("release/version-registry.json");
const environment = readJson(registry.environmentManifestPath);
const packageJson = readJson("package.json");

if (registry.appVersion !== packageJson.version) {
  throw new Error(
    `Registry appVersion ${registry.appVersion} does not match package.json ${packageJson.version}`
  );
}

const aiGatewayContractVersion = extractStringConst(
  registry.aiGateway.sourcePath,
  "AI_GATEWAY_CONTRACT_VERSION"
);
const aiRoutingPolicyContractVersion = extractStringConst(
  registry.aiGateway.sourcePath,
  "AI_ROUTING_POLICY_CONTRACT_VERSION"
);
const integrationRegistryContractVersion = extractStringConst(
  registry.integrations.sourcePath,
  "INTEGRATION_REGISTRY_CONTRACT_VERSION"
);
const jobRuntimeContractVersion = extractStringConst(
  "lib/execution/job-runtime-contracts.ts",
  "JOB_RUNTIME_CONTRACT_VERSION"
);
const businessActionContractVersion = extractStringConst(
  "lib/execution/adapters/business-action.ts",
  "BUSINESS_ACTION_ADAPTER_CONTRACT_VERSION"
);
const softwareWorkerContractVersion = extractStringConst(
  "lib/execution/software-worker.ts",
  "SOFTWARE_WORKER_CONTRACT_VERSION"
);
const storageFabricContractVersion = extractStringConst(
  "lib/resources/storage-fabric.ts",
  "STORAGE_FABRIC_CONTRACT_VERSION"
);
const resilienceContractVersion = extractStringConst(
  "lib/resources/resilience.ts",
  "RESILIENCE_CONTRACT_VERSION"
);
const resourceAdapterSdkContractVersion = extractStringConst(
  "lib/resources/adapter-sdk.ts",
  "RESOURCE_ADAPTER_SDK_CONTRACT_VERSION"
);
const resourcePoolContractVersion = extractStringConst(
  "lib/resources/pools.ts",
  "RESOURCE_POOL_CONTRACT_VERSION"
);
const phase44HarnessVersion = extractStringConst(
  registry.phase44.sourcePath,
  "PHASE44_DETERMINISTIC_HARNESS_VERSION"
);
if (
  registry.aiGateway.contractVersion !== aiGatewayContractVersion
  || registry.aiGateway.routingPolicyContractVersion !== aiRoutingPolicyContractVersion
  || registry.integrations.registryContractVersion !== integrationRegistryContractVersion
  || registry.execution.jobRuntimeContractVersion !== jobRuntimeContractVersion
  || registry.execution.businessActionContractVersion !== businessActionContractVersion
  || registry.execution.softwareWorkerContractVersion !== softwareWorkerContractVersion
  || registry.resourceFabric.storageFabricContractVersion !== storageFabricContractVersion
  || registry.resourceFabric.resilienceContractVersion !== resilienceContractVersion
  || registry.resourceFabric.resourceAdapterSdkContractVersion !== resourceAdapterSdkContractVersion
  || registry.resourceFabric.resourcePoolContractVersion !== resourcePoolContractVersion
  || registry.phase44.deterministicHarnessVersion !== phase44HarnessVersion
) {
  throw new Error("Release registry deterministic contract versions are stale");
}

const voiceIntentContractVersion = extractStringConst(
  registry.voice.sourcePath,
  "VOICE_INTENT_CONTRACT_VERSION"
);
const voiceAdapterContractVersion = extractStringConst(
  registry.voice.sourcePath,
  "VOICE_ADAPTER_CONTRACT_VERSION"
);
if (
  registry.voice.contractVersion !== voiceIntentContractVersion
  || registry.voice.adapterContractVersion !== voiceAdapterContractVersion
  || registry.schemaVersions.voiceIntent?.version !== voiceIntentContractVersion
  || registry.adapters.voiceIntent?.version !== voiceAdapterContractVersion
) {
  throw new Error("Release registry voice contract versions are stale");
}

const currentPolicyVersion = extractStringConst(
  registry.policy.registrySourcePath,
  "CURRENT_POLICY_VERSION"
);
const currentPolicyEngineVersion = extractStringConst(
  registry.policy.engineSourcePath,
  "POLICY_ENGINE_VERSION"
);
if (
  registry.policy.registryVersion !== currentPolicyVersion
  || registry.policy.engineVersion !== currentPolicyEngineVersion
) {
  throw new Error("Release registry policy versions are stale");
}

const sha = gitSha();
const generatedAt = new Date().toISOString();
const isGitHubActions = process.env.GITHUB_ACTIONS === "true";

const schemaVersions = sourceVersionMap(registry.schemaVersions);
const adapterVersions = sourceVersionMap(registry.adapters);
const acceptanceEvidence = sourceEvidence(registry.acceptanceEvidencePaths);
const manualSources = sourceEvidence(registry.manualSourcePaths);
const registrySha256 = sha256(canonicalJson(registry));
const environmentSha256 = sha256(canonicalJson(environment));
const packageLockSha256 = fileHash("package-lock.json");
const workflowSha256 = fileHash(".github/workflows/ci.yml");
const coveragePath = "coverage/control-plane-module-coverage.json";
const qualityEvidence = fs.existsSync(path.join(root, coveragePath))
  ? sourceEvidence([coveragePath])
  : [];
if (isGitHubActions && qualityEvidence.length === 0) {
  throw new Error("CI release generation requires control-plane coverage evidence");
}

const productionEnvironment = environment.environments.production;
const productionReady = Boolean(productionEnvironment?.productionReady);

const ciEvidence = {
  provider: isGitHubActions ? "github-actions" : "local",
  workflow: process.env.GITHUB_WORKFLOW ?? "local",
  runId: process.env.GITHUB_RUN_ID ?? null,
  runNumber: process.env.GITHUB_RUN_NUMBER ?? null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  refName: process.env.GITHUB_REF_NAME ?? null,
  githubSha: process.env.GITHUB_SHA ?? null,
  checkedOutGitSha: sha,
  workflowSha256,
  checksCompletedBeforeGeneration: isGitHubActions
    ? [
        "runtime-verification",
        "secret-scan",
        "architecture-integrity",
        "contract-version-drift",
        "typecheck",
        "lint",
        "tests",
        "control-plane-module-coverage",
        "production-build"
      ]
    : [],
  evidenceStatus: isGitHubActions
    ? "ci-prerequisites-passed-before-artifact-generation"
    : "local-unverified"
};

const manualLines = [
  "# GetDone Operating Manual — Generated Release Anatomy",
  "",
  `Generated: ${generatedAt}`,
  `Git SHA: ${sha}`,
  `App version: ${registry.appVersion}`,
  `Version registry: ${registry.registryVersion} (${registrySha256})`,
  `Version registry schema: ${registry.registrySchemaVersion}`,
  `Release manifest schema: ${registry.schemaVersions.releaseManifest.version}`,
  `Environment manifest schema: ${registry.environmentManifestSchemaVersion}`,
  `Production ready: ${productionReady ? "YES" : "NO"}`,
  "",
  "## Authority model",
  "",
  "AI thinks. GetDone authorizes. Workers execute. Resources supply capacity. Verification establishes truth.",
  "",
  "This generated manual is release evidence, not execution authority. It contains references and versions only; raw credentials must never be placed here.",
  "",
  "## Database and migrations",
  "",
  `- Status: ${registry.database.status}`,
  `- Migration version: ${registry.database.migrationVersion}`,
  `- Schema version: ${registry.database.schemaVersion}`,
  `- Source hash: ${fileHash(registry.database.sourcePath)}`,
  "",
  "## Policy",
  "",
  `- Policy registry version: ${registry.policy.registryVersion}`,
  `- Policy engine version: ${registry.policy.engineVersion}`,
  `- Policy registry source hash: ${fileHash(registry.policy.registrySourcePath)}`,
  `- Policy engine source hash: ${fileHash(registry.policy.engineSourcePath)}`,
  "",
  "## AI Gateway and routing",
  "",
  `- Contract version: ${registry.aiGateway.contractVersion}`,
  `- Routing policy contract version: ${registry.aiGateway.routingPolicyContractVersion}`,
  `- Live status: ${registry.aiGateway.status}`,
  `- Live adapter version: ${registry.aiGateway.adapterVersion}`,
  `- Active model-role routing-policy version: ${registry.aiGateway.routingPolicyVersion}`,
  "",
  "The deterministic AI Gateway contract/router/budget/audit layer exists, while UNIMPLEMENTED/UNCONFIGURED intentionally records that no live OpenRouter/provider adapter or active routing configuration exists.",
  "",
  "## Company Integration Registry",
  "",
  `- Registry contract version: ${registry.integrations.registryContractVersion}`,
  `- Live adapter status: ${registry.integrations.liveAdaptersStatus}`,
  `- Source hash: ${fileHash(registry.integrations.sourcePath)}`,
  "",
  "## Durable execution contracts",
  "",
  `- Job runtime contract: ${registry.execution.jobRuntimeContractVersion}`,
  `- Durable Job Store: ${registry.execution.durableJobStoreStatus}`,
  `- Business action adapter contract: ${registry.execution.businessActionContractVersion}`,
  `- Business action adapters: ${registry.execution.businessAdaptersStatus}`,
  `- Software worker contract: ${registry.execution.softwareWorkerContractVersion}`,
  `- Software deployment executor: ${registry.execution.softwareDeploymentStatus}`,
  ...registry.execution.sourcePaths.map((sourcePath) => `- Contract source: ${sourcePath} — ${fileHash(sourcePath)}`),
  "",
  "## Resource Fabric Phases 36-39",
  "",
  `- Storage Fabric contract: ${registry.resourceFabric.storageFabricContractVersion}`,
  `- Storage runtime: ${registry.resourceFabric.storageRuntimeStatus}`,
  `- Resilience contract: ${registry.resourceFabric.resilienceContractVersion}`,
  `- Failover runtime: ${registry.resourceFabric.failoverRuntimeStatus}`,
  `- Resource Adapter SDK: ${registry.resourceFabric.resourceAdapterSdkContractVersion}`,
  `- Second provider: ${registry.resourceFabric.secondProviderStatus}`,
  `- ResourcePool contract: ${registry.resourceFabric.resourcePoolContractVersion}`,
  `- Partner pool runtime: ${registry.resourceFabric.partnerPoolRuntimeStatus}`,
  ...registry.resourceFabric.sourcePaths.map((sourcePath) => `- Resource Fabric source: ${sourcePath} — ${fileHash(sourcePath)}`),
  "",
  "## Phase 44 adversarial acceptance",
  "",
  `- Deterministic harness version: ${registry.phase44.deterministicHarnessVersion}`,
  `- Deterministic harness status: ${registry.phase44.deterministicHarnessStatus}`,
  `- Production end-to-end acceptance: ${registry.phase44.productionAcceptanceStatus}`,
  `- Harness source hash: ${fileHash(registry.phase44.sourcePath)}`,
  "",
  "Offline adversarial checks are release evidence only. They do not promote unconnected NAS, provider, failover, partner-pool, or production infrastructure to PASS.",
  "",
  "## Voice intent and secure handoff",
  "",
  `- Contract version: ${registry.voice.contractVersion}`,
  `- Adapter contract version: ${registry.voice.adapterContractVersion}`,
  `- Live adapter status: ${registry.voice.adapterStatus}`,
  `- Live adapter version: ${registry.voice.adapterVersion}`,
  `- Speech provider: ${registry.voice.speechProvider}`,
  `- Required for production: ${registry.voice.requiredForProduction ? "yes" : "no"}`,
  `- Strong approval handling: ${registry.voice.strongApprovalHandling}`,
  `- Credential handling: ${registry.voice.credentialHandling}`,
  `- Source hash: ${fileHash(registry.voice.sourcePath)}`,
  "",
  "Voice recognition/classification is evidence only. Voice cannot approve, perform step-up, accept raw credentials, or execute side effects; sensitive/mutating work continues through the existing Control API, policy system, and secure phone handoff.",
  "",
  "## Schema versions",
  "",
  ...Object.entries(schemaVersions).map(
    ([name, entry]) => `- ${name}: ${entry.version} — ${entry.sourcePath} — ${entry.sourceSha256}`
  ),
  "",
  "## Adapter versions",
  "",
  ...Object.entries(adapterVersions).map(
    ([name, entry]) => `- ${name}: ${entry.version} [${entry.status}] — ${entry.sourcePath} — ${entry.sourceSha256}`
  ),
  "",
  "## Environment anatomy",
  "",
  ...Object.entries(environment.environments).flatMap(([name, value]) => [
    `### ${name}`,
    `- Authority mode: ${value.authorityMode}`,
    `- Production ready: ${value.productionReady ? "yes" : "no"}`,
    `- Data mode: ${value.dataMode}`,
    `- Deployment status: ${value.deployment.status}`,
    `- Deployment ID: ${value.deployment.deploymentId ?? "n/a"}`,
    `- Deployment region: ${value.deployment.region ?? "n/a"}`,
    `- Voice contract status: ${value.voice.contractStatus}`,
    `- Voice adapter status: ${value.voice.adapterStatus}`,
    `- Voice strong approval allowed: ${value.voice.strongApprovalAllowed ? "yes" : "no"}`,
    `- Voice raw credential input allowed: ${value.voice.rawCredentialInputAllowed ? "yes" : "no"}`,
    `- Voice secure handoff: ${value.voice.secureHandoff}`,
    `- AI Gateway contract/live adapter: ${value.aiGateway.contractStatus} / ${value.aiGateway.adapterStatus}`,
    `- Integration registry/live adapter: ${value.integrations.registryStatus} / ${value.integrations.adapterStatus}`,
    `- Durable Job contract/store: ${value.execution.jobRuntimeContractStatus} / ${value.execution.durableJobStoreStatus}`,
    `- Business action adapter: ${value.execution.businessActionAdapterStatus}`,
    `- Software deployment executor: ${value.execution.softwareDeploymentStatus}`,
    `- Storage Fabric contract/runtime: ${value.resourceFabric.storageFabricContractStatus} / ${value.resourceFabric.storageRuntimeStatus}`,
    `- Resilience contract/failover runtime: ${value.resourceFabric.resilienceContractStatus} / ${value.resourceFabric.failoverRuntimeStatus}`,
    `- Resource Adapter SDK/second provider: ${value.resourceFabric.resourceAdapterSdkStatus} / ${value.resourceFabric.secondProviderStatus}`,
    `- ResourcePool contract/partner runtime: ${value.resourceFabric.resourcePoolContractStatus} / ${value.resourceFabric.partnerPoolRuntimeStatus}`,
    `- Phase 44 deterministic/production acceptance: ${value.phase44.deterministicHarnessStatus} / ${value.phase44.productionAcceptanceStatus}`,
    ...Object.entries(value.connections).map(
      ([connection, connected]) => `- ${connection}: ${connected ? "connected" : "not connected"}`
    ),
    ""
  ]),
  "## CI evidence",
  "",
  `- Provider: ${ciEvidence.provider}`,
  `- Workflow: ${ciEvidence.workflow}`,
  `- Run ID: ${ciEvidence.runId ?? "n/a"}`,
  `- Run number: ${ciEvidence.runNumber ?? "n/a"}`,
  `- Checked-out Git SHA: ${ciEvidence.checkedOutGitSha}`,
  `- Evidence status: ${ciEvidence.evidenceStatus}`,
  "",
  "## Release flow",
  "",
  "1. code",
  "2. test",
  "3. staging",
  "4. verify",
  "5. generate manual + machine manifest",
  "6. diff",
  "7. approval when required",
  "8. production",
  "9. verify",
  "10. archive evidence",
  "",
  "Stages that are not connected in the environment manifest remain incomplete; this manual never upgrades them to production-ready.",
  "",
  "## Source manuals and evidence",
  "",
  ...manualSources.map(
    (entry) => `- manual source: ${entry.sourcePath} — ${entry.sourceSha256}`
  ),
  ...acceptanceEvidence.map(
    (entry) => `- acceptance evidence: ${entry.sourcePath} — ${entry.sourceSha256}`
  ),
  ...qualityEvidence.map(
    (entry) => `- generated quality evidence: ${entry.sourcePath} — ${entry.sourceSha256}`
  ),
  ""
];

fs.mkdirSync(outDir, { recursive: true });
const operatingManual = manualLines.join("\n");
fs.writeFileSync(
  path.join(root, registry.generatedArtifacts.operatingManual),
  operatingManual,
  "utf8"
);

const generatedManualSha256 = sha256(operatingManual);
const manifestBase = {
  manifestSchemaVersion: registry.schemaVersions.releaseManifest.version,
  registrySchemaVersion: registry.registrySchemaVersion,
  environmentManifestSchemaVersion: registry.environmentManifestSchemaVersion,
  registryVersion: registry.registryVersion,
  registrySha256,
  generatedAt,
  gitSha: sha,
  appVersion: registry.appVersion,
  packageLockSha256,
  schemaVersions,
  database: {
    ...registry.database,
    sourceSha256: fileHash(registry.database.sourcePath)
  },
  policy: {
    ...registry.policy,
    registrySourceSha256: fileHash(registry.policy.registrySourcePath),
    engineSourceSha256: fileHash(registry.policy.engineSourcePath)
  },
  aiGateway: {
    ...registry.aiGateway,
    sourceSha256: fileHash(registry.aiGateway.sourcePath)
  },
  integrations: {
    ...registry.integrations,
    sourceSha256: fileHash(registry.integrations.sourcePath)
  },
  execution: {
    ...registry.execution,
    sourceEvidence: sourceEvidence(registry.execution.sourcePaths)
  },
  resourceFabric: {
    ...registry.resourceFabric,
    sourceEvidence: sourceEvidence(registry.resourceFabric.sourcePaths)
  },
  phase44: {
    ...registry.phase44,
    sourceSha256: fileHash(registry.phase44.sourcePath)
  },
  voice: {
    ...registry.voice,
    sourceSha256: fileHash(registry.voice.sourcePath)
  },
  adapterVersions,
  environment: {
    sourcePath: registry.environmentManifestPath,
    sourceSha256: environmentSha256,
    manifest: environment
  },
  ciEvidence,
  acceptanceEvidence,
  qualityEvidence,
  manuals: {
    generatedOperatingManualPath: registry.generatedArtifacts.operatingManual,
    generatedOperatingManualSha256: generatedManualSha256,
    sources: manualSources
  },
  releaseStatus: productionReady ? "production-ready-declared" : "not-production-ready"
};
const manifest = {
  ...manifestBase,
  manifestHash: sha256(canonicalJson(manifestBase))
};

fs.writeFileSync(
  path.join(root, registry.generatedArtifacts.machineManifest),
  JSON.stringify(manifest, null, 2) + "\n",
  "utf8"
);

console.log(
  `Generated Phase 41 release artifacts for ${sha} at ${registry.generatedArtifacts.machineManifest}`
);
