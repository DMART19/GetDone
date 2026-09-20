import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function fail(message) {
  failures.push(message);
}

function walk(dir) {
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) return [];
  const entries = fs.readdirSync(absolute, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".next", ".git"].includes(entry.name)) return [];
      return walk(relative);
    }
    return /\.(?:ts|tsx|js|mjs)$/.test(entry.name) ? [relative] : [];
  });
}

const bottomNav = read("components/bottom-nav.tsx");
const labels = [...bottomNav.matchAll(/label:\s*"([^"]+)"/g)].map((match) => match[1]);
if (JSON.stringify(labels) !== JSON.stringify(["Chat", "Decisions", "Resources"])) {
  fail(`Permanent owner navigation drifted: expected Chat, Decisions, Resources; got ${labels.join(", ")}`);
}

const readme = read("README.md");
if (!readme.includes("AI thinks. GetDone authorizes. Workers execute. Resources supply capacity. Verification establishes truth.")) {
  fail("README authority rule is missing or changed");
}

const architecture = read("docs/ARCHITECTURE.md");
if (architecture.includes("full PWA/service-worker delivery remains a later phase")) {
  fail("ARCHITECTURE.md contains stale Phase 25 PWA wording");
}

const envExample = read(".env.example");
if (/NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|CREDENTIAL|PASSWORD)/.test(envExample)) {
  fail(".env.example exposes a secret-like NEXT_PUBLIC variable");
}

const packageJson = JSON.parse(read("package.json"));
const allDependencies = {
  ...(packageJson.dependencies ?? {}),
  ...(packageJson.devDependencies ?? {})
};
const providerPackages = new Set([
  "openai",
  "@anthropic-ai/sdk",
  "@google/generative-ai",
  "@google/genai"
]);
for (const dependency of Object.keys(allDependencies)) {
  if (providerPackages.has(dependency) && !fs.existsSync(path.join(root, "lib/ai-gateway"))) {
    fail(`Provider SDK ${dependency} is installed before the GetDone-owned lib/ai-gateway boundary exists`);
  }
}

const codeFiles = [
  ...walk("app"),
  ...walk("components"),
  ...walk("lib"),
  ...walk("scripts")
];

const providerImportPatterns = [
  /from\s+["']openai["']/,
  /from\s+["']@anthropic-ai\/sdk["']/,
  /from\s+["']@google\/(?:generative-ai|genai)["']/,
  /https:\/\/(?:openrouter\.ai|api\.openai\.com|api\.anthropic\.com)/
];

for (const file of codeFiles) {
  const content = read(file);
  const normalized = file.replaceAll("\\", "/");

  if (!normalized.startsWith("lib/ai-gateway/")) {
    for (const pattern of providerImportPatterns) {
      if (pattern.test(content)) {
        fail(`Model/provider integration escaped lib/ai-gateway: ${normalized}`);
      }
    }
  }

  if (
    content.includes('from "@/lib/mock-data"')
    && ![
      "lib/data/repository.ts",
      "lib/mock-data.test.ts",
      "scripts/verify-architecture.mjs"
    ].includes(normalized)
  ) {
    fail(`Development seed data imported outside the repository seam: ${normalized}`);
  }

  if (
    /NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|CREDENTIAL|PASSWORD)/.test(content)
  ) {
    fail(`Secret-like public environment variable referenced in ${normalized}`);
  }
}

const simulator = read("lib/resources/policy-simulator.ts");
for (const prohibitedImport of [
  "@/lib/resources/reservations",
  "@/lib/resources/scheduler",
  "@/lib/credentials/broker"
]) {
  if (simulator.includes(prohibitedImport)) {
    fail(`Zero-side-effect simulator imports an execution-authority module: ${prohibitedImport}`);
  }
}

const scheduler = read("lib/resources/scheduler.ts");
for (const required of [
  "governorReportHash",
  "assertGovernorAllowsAutonomousScheduling",
  "credentialLeaseHash",
  "DispatchAdmissionReceipt",
  "blockingKillSwitches",
  "verificationTrustAttestation",
  "jobStateMutationApplied: false"
]) {
  if (!scheduler.includes(required)) {
    fail(`Phase 34 architecture binding missing: ${required}`);
  }
}

const sourceTrust = read("lib/verification/source-trust.ts");
for (const required of [
  "VerificationSourceBinding",
  "independenceDomain",
  "createVerificationTrustAttestation",
  "assertVerificationTrustAttestation"
]) {
  if (!sourceTrust.includes(required)) {
    fail(`Verification source trust contract missing: ${required}`);
  }
}

const ci = read(".github/workflows/ci.yml");
if (!ci.includes("npm run verify:architecture")) {
  fail("CI does not run the architectural drift gate");
}

const releaseRegistry = JSON.parse(read("release/version-registry.json"));
const releaseEnvironment = JSON.parse(read("release/environment-manifest.json"));
for (const required of [
  "registrySchemaVersion",
  "registryVersion",
  "appVersion",
  "schemaVersions",
  "database",
  "policy",
  "aiGateway",
  "adapters",
  "environmentManifestPath",
  "acceptanceEvidencePaths",
  "manualSourcePaths",
  "generatedArtifacts"
]) {
  if (!(required in releaseRegistry)) {
    fail(`Phase 41 version registry is missing: ${required}`);
  }
}
if (
  releaseRegistry.appVersion !== packageJson.version
  || releaseRegistry.environmentManifestPath !== "release/environment-manifest.json"
) {
  fail("Phase 41 registry app/environment binding drifted");
}
if (
  releaseRegistry.aiGateway.status === "not-connected"
  && (
    releaseRegistry.aiGateway.adapterVersion !== "UNIMPLEMENTED"
    || releaseRegistry.aiGateway.routingPolicyVersion !== "UNCONFIGURED"
  )
) {
  fail("Disconnected AI Gateway release state must remain explicitly UNIMPLEMENTED/UNCONFIGURED");
}
if (
  !releaseEnvironment.environments?.development
  || !releaseEnvironment.environments?.staging
  || !releaseEnvironment.environments?.production
) {
  fail("Phase 41 environment manifest must define development, staging, and production");
}
for (const requiredScript of [
  "npm run release:generate",
  "npm run verify:release",
  "actions/upload-artifact@v4"
]) {
  if (!ci.includes(requiredScript)) {
    fail(`CI does not preserve Phase 41 release evidence step: ${requiredScript}`);
  }
}

if (failures.length > 0) {
  console.error("GetDone architecture integrity verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("GetDone architecture integrity verification passed.");
