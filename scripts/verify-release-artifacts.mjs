import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const failures = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}
function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}
function fail(message) {
  failures.push(message);
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
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
function gitSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  }).trim();
}
function extractStringConst(relativePath, name) {
  const match = read(relativePath).match(
    new RegExp(`export const ${name} = ["']([^"']+)["']`)
  );
  return match?.[1];
}
function looksSecretBearing(content) {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/,
    /(?:api[_-]?key|password|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["'][^"']{12,}["']/i
  ];
  return patterns.some((pattern) => pattern.test(content));
}

const registry = readJson("release/version-registry.json");
const environment = readJson(registry.environmentManifestPath);
const packageJson = readJson("package.json");
const manifestPath = registry.generatedArtifacts.machineManifest;
const manualPath = registry.generatedArtifacts.operatingManual;

for (const requiredPath of [manifestPath, manualPath]) {
  if (!fs.existsSync(path.join(root, requiredPath))) {
    fail(`Missing generated release artifact: ${requiredPath}`);
  }
}

if (failures.length === 0) {
  const manifest = readJson(manifestPath);
  const manual = read(manualPath);
  const { manifestHash, ...manifestBase } = manifest;

  if (sha256(canonicalJson(manifestBase)) !== manifestHash) {
    fail("Release manifest integrity hash does not match its contents");
  }
  if (manifest.gitSha !== gitSha()) {
    fail("Release manifest Git SHA does not match the checked-out commit");
  }
  if (
    manifest.manifestSchemaVersion !== registry.schemaVersions.releaseManifest.version
    || manifest.registrySchemaVersion !== registry.registrySchemaVersion
    || registry.environmentManifestSchemaVersion !== environment.manifestSchemaVersion
    || manifest.environmentManifestSchemaVersion !== environment.manifestSchemaVersion
  ) {
    fail("Release/environment registry schema version drift detected");
  }
  if (manifest.appVersion !== packageJson.version || registry.appVersion !== packageJson.version) {
    fail("App version drift exists between package.json, registry, and release manifest");
  }
  if (manifest.registrySha256 !== sha256(canonicalJson(registry))) {
    fail("Release manifest version-registry hash is stale");
  }
  if (manifest.environment.sourceSha256 !== sha256(canonicalJson(environment))) {
    fail("Release manifest environment-manifest hash is stale");
  }
  if (manifest.packageLockSha256 !== fileHash("package-lock.json")) {
    fail("Release manifest package-lock hash is stale");
  }

  for (const [name, entry] of Object.entries(registry.schemaVersions)) {
    const manifested = manifest.schemaVersions[name];
    if (
      !manifested
      || manifested.version !== entry.version
      || manifested.sourcePath !== entry.sourcePath
      || manifested.sourceSha256 !== fileHash(entry.sourcePath)
    ) {
      fail(`Schema version/source drift: ${name}`);
    }
  }

  for (const [name, entry] of Object.entries(registry.adapters)) {
    const manifested = manifest.adapterVersions[name];
    if (
      !manifested
      || manifested.version !== entry.version
      || manifested.status !== entry.status
      || manifested.sourcePath !== entry.sourcePath
      || manifested.sourceSha256 !== fileHash(entry.sourcePath)
    ) {
      fail(`Adapter version/source drift: ${name}`);
    }
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
  const jobExecutionBridgeContractVersion = extractStringConst(
    "lib/domain/services/job-execution-bridge.ts",
    "JOB_EXECUTION_BRIDGE_CONTRACT_VERSION"
  );
  const goldenPathHarnessVersion = extractStringConst(
    registry.composition.sourcePath,
    "GOLDEN_PATH_HARNESS_VERSION"
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
    || manifest.aiGateway.contractVersion !== aiGatewayContractVersion
    || manifest.aiGateway.routingPolicyContractVersion !== aiRoutingPolicyContractVersion
    || registry.integrations.registryContractVersion !== integrationRegistryContractVersion
    || manifest.integrations.registryContractVersion !== integrationRegistryContractVersion
    || manifest.integrations.sourceSha256 !== fileHash(registry.integrations.sourcePath)
    || registry.execution.jobRuntimeContractVersion !== jobRuntimeContractVersion
    || registry.execution.businessActionContractVersion !== businessActionContractVersion
    || registry.execution.softwareWorkerContractVersion !== softwareWorkerContractVersion
    || registry.execution.jobExecutionBridgeContractVersion !== jobExecutionBridgeContractVersion
    || manifest.execution.jobExecutionBridgeContractVersion !== jobExecutionBridgeContractVersion
    || registry.composition.goldenPathHarnessVersion !== goldenPathHarnessVersion
    || manifest.composition.goldenPathHarnessVersion !== goldenPathHarnessVersion
    || manifest.composition.sourceSha256 !== fileHash(registry.composition.sourcePath)
    || registry.resourceFabric.storageFabricContractVersion !== storageFabricContractVersion
    || registry.resourceFabric.resilienceContractVersion !== resilienceContractVersion
    || registry.resourceFabric.resourceAdapterSdkContractVersion !== resourceAdapterSdkContractVersion
    || registry.resourceFabric.resourcePoolContractVersion !== resourcePoolContractVersion
    || registry.phase44.deterministicHarnessVersion !== phase44HarnessVersion
    || manifest.resourceFabric.storageFabricContractVersion !== storageFabricContractVersion
    || manifest.resourceFabric.resilienceContractVersion !== resilienceContractVersion
    || manifest.resourceFabric.resourceAdapterSdkContractVersion !== resourceAdapterSdkContractVersion
    || manifest.resourceFabric.resourcePoolContractVersion !== resourcePoolContractVersion
    || manifest.phase44.deterministicHarnessVersion !== phase44HarnessVersion
    || manifest.phase44.sourceSha256 !== fileHash(registry.phase44.sourcePath)
  ) {
    fail("Deterministic Phase 4/13/19-21/34-bridge/36-39/44/composition contract/version registry drift detected");
  }
  for (const evidence of manifest.execution.sourceEvidence ?? []) {
    if (evidence.sourceSha256 !== fileHash(evidence.sourcePath)) {
      fail(`Execution contract source drift: ${evidence.sourcePath}`);
    }
  }
  for (const evidence of manifest.resourceFabric.sourceEvidence ?? []) {
    if (evidence.sourceSha256 !== fileHash(evidence.sourcePath)) {
      fail(`Resource Fabric contract source drift: ${evidence.sourcePath}`);
    }
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
    voiceIntentContractVersion !== registry.voice.contractVersion
    || voiceAdapterContractVersion !== registry.voice.adapterContractVersion
    || registry.schemaVersions.voiceIntent?.version !== voiceIntentContractVersion
    || registry.adapters.voiceIntent?.version !== voiceAdapterContractVersion
    || manifest.voice.contractVersion !== voiceIntentContractVersion
    || manifest.voice.adapterContractVersion !== voiceAdapterContractVersion
    || manifest.voice.sourceSha256 !== fileHash(registry.voice.sourcePath)
  ) {
    fail("Voice contract/version registry drift detected");
  }
  if (
    registry.voice.adapterStatus === "not-connected"
    && (
      registry.voice.adapterVersion !== "UNIMPLEMENTED"
      || registry.voice.speechProvider !== "UNCONFIGURED"
      || registry.adapters.voiceIntent?.status !== "contract-only"
    )
  ) {
    fail("Disconnected voice runtime must remain explicitly UNIMPLEMENTED/UNCONFIGURED with a contract-only adapter");
  }
  if (
    registry.voice.strongApprovalHandling !== "secure-phone-only"
    || registry.voice.credentialHandling !== "secure-provider-or-phone-only"
  ) {
    fail("Voice release state cannot weaken strong approval or credential handoff");
  }

  const policyVersion = extractStringConst(
    registry.policy.registrySourcePath,
    "CURRENT_POLICY_VERSION"
  );
  const policyEngineVersion = extractStringConst(
    registry.policy.engineSourcePath,
    "POLICY_ENGINE_VERSION"
  );
  if (
    policyVersion !== registry.policy.registryVersion
    || policyEngineVersion !== registry.policy.engineVersion
    || manifest.policy.registryVersion !== policyVersion
    || manifest.policy.engineVersion !== policyEngineVersion
  ) {
    fail("Policy version registry drift detected");
  }

  if (registry.database.status === "not-connected") {
    if (
      registry.database.migrationVersion !== "UNIMPLEMENTED"
      || registry.database.schemaVersion !== "UNIMPLEMENTED"
      || manifest.database.migrationVersion !== "UNIMPLEMENTED"
      || manifest.database.schemaVersion !== "UNIMPLEMENTED"
      || manifest.database.sourceSha256 !== fileHash(registry.database.sourcePath)
    ) {
      fail("Disconnected database must declare exact UNIMPLEMENTED migration/schema versions");
    }
  } else if (
    registry.database.migrationVersion === "UNIMPLEMENTED"
    || registry.database.schemaVersion === "UNIMPLEMENTED"
  ) {
    fail("Connected database cannot retain UNIMPLEMENTED migration/schema versions");
  }

  if (registry.aiGateway.status === "not-connected") {
    if (
      registry.aiGateway.adapterVersion !== "UNIMPLEMENTED"
      || registry.aiGateway.routingPolicyVersion !== "UNCONFIGURED"
      || registry.adapters.aiGateway?.status !== "contract-only"
    ) {
      fail("Disconnected AI Gateway must retain contract-only adapter state plus UNIMPLEMENTED/UNCONFIGURED live state");
    }
  } else if (
    registry.aiGateway.adapterVersion === "UNIMPLEMENTED"
    || registry.aiGateway.routingPolicyVersion === "UNCONFIGURED"
  ) {
    fail("Connected AI Gateway cannot retain unimplemented routing/adapter versions");
  }

  if (
    registry.integrations.liveAdaptersStatus !== "not-connected"
    || registry.execution.durableJobStoreStatus !== "not-connected"
    || registry.execution.businessAdaptersStatus !== "not-connected"
    || registry.execution.softwareDeploymentStatus !== "not-connected"
    || registry.execution.jobExecutionBridgeStatus !== "deterministic-contract"
    || registry.execution.liveJobExecutionBridgeStoreStatus !== "not-connected"
    || registry.composition.status !== "deterministic-simulation-only"
    || registry.composition.productionExecutionClaimed !== false
    || registry.resourceFabric.storageRuntimeStatus !== "not-connected"
    || registry.resourceFabric.failoverRuntimeStatus !== "not-connected"
    || registry.resourceFabric.secondProviderStatus !== "not-connected"
    || registry.resourceFabric.partnerPoolRuntimeStatus !== "not-connected"
    || registry.adapters.resourceAdapterSdk?.status !== "contract-only"
    || registry.phase44.productionAcceptanceStatus !== "not-run"
  ) {
    fail("Release registry must not claim live Job bridge/composition or unconnected Phase 4/19-21/36-39/44 runtime acceptance");
  }

  for (const evidence of manifest.acceptanceEvidence) {
    if (evidence.sourceSha256 !== fileHash(evidence.sourcePath)) {
      fail(`Acceptance evidence drift: ${evidence.sourcePath}`);
    }
  }
  for (const source of manifest.manuals.sources) {
    if (source.sourceSha256 !== fileHash(source.sourcePath)) {
      fail(`Manual source drift: ${source.sourcePath}`);
    }
  }
  if (manifest.manuals.generatedOperatingManualSha256 !== sha256(manual)) {
    fail("Generated operating manual hash does not match the release manifest");
  }

  for (const [name, environmentState] of Object.entries(environment.environments)) {
    if (
      !environmentState.aiGateway
      || environmentState.aiGateway.contractStatus !== "deterministic-contract"
      || environmentState.aiGateway.adapterStatus !== "not-connected"
      || environmentState.connections.aiGateway !== false
      || !environmentState.integrations
      || environmentState.integrations.registryStatus !== "deterministic-contract"
      || environmentState.integrations.adapterStatus !== "not-connected"
      || !environmentState.execution
      || environmentState.execution.jobRuntimeContractStatus !== "deterministic-contract"
      || environmentState.execution.durableJobStoreStatus !== "not-connected"
      || environmentState.execution.businessActionAdapterStatus !== "not-connected"
      || environmentState.execution.softwareDeploymentStatus !== "not-connected"
      || environmentState.execution.jobExecutionBridgeStatus !== "deterministic-contract"
      || environmentState.execution.liveJobExecutionBridgeStoreStatus !== "not-connected"
      || !environmentState.composition
      || environmentState.composition.goldenPathHarnessStatus !== "deterministic-simulation-only"
      || environmentState.composition.productionExecutionClaimed !== false
      || !environmentState.resourceFabric
      || environmentState.resourceFabric.storageFabricContractStatus !== "deterministic-contract"
      || environmentState.resourceFabric.storageRuntimeStatus !== "not-connected"
      || environmentState.resourceFabric.resilienceContractStatus !== "deterministic-contract"
      || environmentState.resourceFabric.failoverRuntimeStatus !== "not-connected"
      || environmentState.resourceFabric.resourceAdapterSdkStatus !== "deterministic-contract"
      || environmentState.resourceFabric.secondProviderStatus !== "not-connected"
      || environmentState.resourceFabric.resourcePoolContractStatus !== "deterministic-contract"
      || environmentState.resourceFabric.partnerPoolRuntimeStatus !== "not-connected"
      || !environmentState.phase44
      || environmentState.phase44.deterministicHarnessStatus !== "offline-blocking-suite"
      || environmentState.phase44.productionAcceptanceStatus !== "not-run"
    ) {
      fail(`Phase 4/13/19-21/34-bridge/36-39/44/composition environment contract/live-state drift: ${name}`);
    }
    if (
      !environmentState.voice
      || environmentState.voice.contractStatus !== "deterministic-contract"
      || environmentState.voice.strongApprovalAllowed !== false
      || environmentState.voice.rawCredentialInputAllowed !== false
      || environmentState.voice.secureHandoff !== "iphone-control-surface"
    ) {
      fail(`Voice environment authority drift: ${name}`);
    }
    if (
      environmentState.connections.voiceAdapter === false
      && environmentState.voice.adapterStatus !== "not-connected"
    ) {
      fail(`Voice adapter connection/status mismatch: ${name}`);
    }
  }

  const production = environment.environments.production;
  if (
    production.productionReady
    && (
      Object.values(production.connections).some((connected) => connected !== true)
      || (registry.voice.requiredForProduction && production.connections.voiceAdapter !== true)
      || production.deployment?.status !== "connected"
      || !production.deployment?.deploymentId
    )
  ) {
    fail("Production cannot be declared ready without a connected deployment and all required connections");
  }
  if (
    !["development", "staging", "production"].every(
      (name) => environment.environments[name]
    )
  ) {
    fail("Environment manifest must define development, staging, and production");
  }

  if (process.env.GITHUB_ACTIONS === "true") {
    const coverageEvidence = (manifest.qualityEvidence ?? []).find(
      (entry) => entry.sourcePath === "coverage/control-plane-module-coverage.json"
    );
    if (
      !coverageEvidence
      || coverageEvidence.sourceSha256 !== fileHash("coverage/control-plane-module-coverage.json")
    ) {
      fail("GitHub Actions release evidence is missing verified control-plane coverage output");
    }
    if (
      manifest.ciEvidence.provider !== "github-actions"
      || manifest.ciEvidence.runId !== process.env.GITHUB_RUN_ID
      || manifest.ciEvidence.runNumber !== process.env.GITHUB_RUN_NUMBER
      || manifest.ciEvidence.checkedOutGitSha !== gitSha()
      || manifest.ciEvidence.githubSha !== process.env.GITHUB_SHA
    ) {
      fail("GitHub Actions CI evidence does not match the current workflow execution");
    }
  }

  if (!manual.includes(`Git SHA: ${manifest.gitSha}`)) {
    fail("Operating manual does not bind the current Git SHA");
  }
  if (!manual.includes(`App version: ${manifest.appVersion}`)) {
    fail("Operating manual does not bind the current app version");
  }

  for (const [relativePath, content] of [
    ["release/version-registry.json", read("release/version-registry.json")],
    [registry.environmentManifestPath, read(registry.environmentManifestPath)],
    [manifestPath, read(manifestPath)],
    [manualPath, manual]
  ]) {
    if (looksSecretBearing(content)) {
      fail(`Release artifact appears to contain raw secret material: ${relativePath}`);
    }
  }
}

if (failures.length > 0) {
  console.error("GetDone Phase 41 release verification failed:");
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}

console.log("GetDone Phase 41 release verification passed.");
