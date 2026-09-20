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
        "typecheck",
        "lint",
        "tests",
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
  `Production ready: ${productionReady ? "YES" : "NO"}`,
  "",
  "## Authority model",
  "",
  "AI thinks. GetDone authorizes. Workers execute. Resources supply capacity. Verification establishes truth.",
  "",
  "This generated manual is release evidence, not execution authority. It contains references and versions only; raw credentials must never be placed here.",
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
  `- Status: ${registry.aiGateway.status}`,
  `- Adapter version: ${registry.aiGateway.adapterVersion}`,
  `- Model-role routing-policy version: ${registry.aiGateway.routingPolicyVersion}`,
  "",
  "An UNIMPLEMENTED or UNCONFIGURED value is intentional evidence that no live AI Gateway/routing policy is active in this release. It must not be replaced with an invented provider/version.",
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
  registryVersion: registry.registryVersion,
  registrySha256,
  generatedAt,
  gitSha: sha,
  appVersion: registry.appVersion,
  packageLockSha256,
  schemaVersions,
  policy: {
    ...registry.policy,
    registrySourceSha256: fileHash(registry.policy.registrySourcePath),
    engineSourceSha256: fileHash(registry.policy.engineSourcePath)
  },
  aiGateway: {
    ...registry.aiGateway,
    sourceSha256: fileHash(registry.aiGateway.sourcePath)
  },
  adapterVersions,
  environment: {
    sourcePath: registry.environmentManifestPath,
    sourceSha256: environmentSha256,
    manifest: environment
  },
  ciEvidence,
  acceptanceEvidence,
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
