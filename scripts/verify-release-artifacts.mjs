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
    ) {
      fail("Disconnected AI Gateway must declare exact UNIMPLEMENTED/UNCONFIGURED versions");
    }
  } else if (
    registry.aiGateway.adapterVersion === "UNIMPLEMENTED"
    || registry.aiGateway.routingPolicyVersion === "UNCONFIGURED"
  ) {
    fail("Connected AI Gateway cannot retain unimplemented routing/adapter versions");
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
