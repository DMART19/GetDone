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
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".next", ".git", "coverage", "release/out"].includes(entry.name)) return [];
      return walk(relative);
    }
    return /\.(?:ts|tsx|js|mjs)$/.test(entry.name) ? [relative.replaceAll("\\", "/")] : [];
  });
}
function importsOf(content) {
  const values = [];
  for (const match of content.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)) {
    values.push(match[1]);
  }
  return values;
}
function startsWithAny(value, prefixes) {
  return prefixes.some((prefix) => value.startsWith(prefix));
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
const allDependencies = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
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

const codeFiles = [...walk("app"), ...walk("components"), ...walk("lib"), ...walk("scripts")];
const providerImportPatterns = [
  /from\s+["']openai["']/,
  /from\s+["']@anthropic-ai\/sdk["']/,
  /from\s+["']@google\/(?:generative-ai|genai)["']/,
  /https:\/\/(?:openrouter\.ai|api\.openai\.com|api\.anthropic\.com)/
];

for (const file of codeFiles) {
  const content = read(file);
  if (!file.startsWith("lib/ai-gateway/")) {
    for (const pattern of providerImportPatterns) {
      if (pattern.test(content)) fail(`Model/provider integration escaped lib/ai-gateway: ${file}`);
    }
  }
  if (
    content.includes('from "@/lib/mock-data"')
    && !["lib/data/repository.ts", "lib/mock-data.test.ts", "scripts/verify-architecture.mjs"].includes(file)
  ) {
    fail(`Development seed data imported outside the repository seam: ${file}`);
  }
  if (/NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|CREDENTIAL|PASSWORD)/.test(content)) {
    fail(`Secret-like public environment variable referenced in ${file}`);
  }
}

const matrix = JSON.parse(read("architecture/dependency-boundaries.json"));
for (const rule of matrix.rules) {
  for (const file of codeFiles) {
    if (!startsWithAny(file, rule.fromPrefixes)) continue;
    if (startsWithAny(file, rule.allowFromPrefixes ?? [])) continue;
    const imports = importsOf(read(file));
    for (const imported of imports) {
      if (startsWithAny(imported, rule.denyImportPrefixes)) {
        fail(`Dependency boundary ${rule.id} violated: ${file} -> ${imported}`);
      }
    }
  }
}

const simulator = read("lib/resources/policy-simulator.ts");
for (const prohibitedImport of [
  "@/lib/resources/reservations",
  "@/lib/resources/scheduler",
  "@/lib/credentials/broker",
  "@/lib/execution/"
]) {
  if (simulator.includes(prohibitedImport)) {
    fail(`Zero-side-effect simulator imports an execution-authority module: ${prohibitedImport}`);
  }
}

const schedulerPublic = read("lib/resources/scheduler.ts");
const schedulerCore = read("lib/resources/internal/scheduler-core.ts");
const schedulerTypes = read("lib/resources/internal/scheduler-types.ts");
if (
  !schedulerPublic.includes('export * from "@/lib/resources/internal/scheduler-types"')
  || !schedulerPublic.includes('export * from "@/lib/resources/internal/scheduler-core"')
) {
  fail("Scheduler stable public barrel no longer re-exports its internal contract/core modules");
}
for (const required of [
  "governorReportHash",
  "assertGovernorAllowsAutonomousScheduling",
  "credentialLeaseHash",
  "DispatchAdmissionReceipt",
  "blockingKillSwitches",
  "verificationTrustAttestation",
  "jobStateMutationApplied: false"
]) {
  if (!(schedulerCore + schedulerTypes).includes(required)) {
    fail(`Phase 34 architecture binding missing after refactor: ${required}`);
  }
}

const reservationsPublic = read("lib/resources/reservations.ts");
if (
  !reservationsPublic.includes('export * from "@/lib/resources/internal/reservation-types"')
  || !reservationsPublic.includes('export * from "@/lib/resources/internal/reservation-core"')
) {
  fail("Reservation stable public barrel no longer re-exports its internal contract/core modules");
}

const aiContracts = read("lib/ai-gateway/contracts.ts");
const aiGateway = read("lib/ai-gateway/gateway.ts");
const aiRouter = read("lib/ai-gateway/router.ts");
for (const required of [
  'AI_GATEWAY_CONTRACT_VERSION = "1.0.0"',
  '"DETERMINISTIC"',
  '"HIGH_REASONING"',
  '"CODING"',
  '"VISION"',
  '"LONG_CONTEXT"',
  "AIGatewayAdapter",
  "AIRequirementEnvelope"
]) {
  if (!aiContracts.includes(required)) fail(`Phase 13 AI Gateway contract missing: ${required}`);
}
for (const required of [
  "DETERMINISTIC work must not invoke a model adapter",
  "NO_ELIGIBLE_MODEL",
  "outputSchema.safeParse",
  "admitAIBudget"
]) {
  if (!aiGateway.includes(required)) fail(`Phase 13 gateway fail-closed behavior missing: ${required}`);
}
for (const required of ["blockingKillSwitches", "profile-not-validated", "structured-output-not-supported"]) {
  if (!aiRouter.includes(required)) fail(`Phase 13 routing guard missing: ${required}`);
}

const integration = read("lib/integrations/registry.ts");
for (const required of [
  "credentialBindingId",
  "readScopes",
  "writeScopes",
  "outside trusted company/environment scope",
  "Mock integration adapters are DEVELOPMENT-only"
]) {
  if (!integration.includes(required)) fail(`Phase 4 Integration Registry guard missing: ${required}`);
}

const jobRuntime = read("lib/execution/job-runtime-contracts.ts");
for (const required of [
  "DurableJobStore",
  "claimAtomic",
  "heartbeat",
  "scheduleRetry",
  "deadLetter",
  "recoverExpired",
  "No in-memory"
]) {
  if (!jobRuntime.includes(required)) fail(`Phase 19 durable runtime contract missing: ${required}`);
}

const businessAdapter = read("lib/execution/adapters/business-action.ts");
for (const required of [
  "authorizationConsumptionHash",
  "idempotencyKey",
  "jobStateMutationApplied: false",
  "Production business actions require a scoped credential lease reference"
]) {
  if (!businessAdapter.includes(required)) fail(`Phase 20 adapter authority guard missing: ${required}`);
}

const softwareWorker = read("lib/execution/software-worker.ts");
for (const required of [
  'codingRole: "CODING"',
  "productionApprovalRequired: true",
  "stagingVerificationReceiptId",
  "Production promotion requires approval receipt",
  "SoftwareDeploymentExecutor"
]) {
  if (!softwareWorker.includes(required)) fail(`Phase 21 software worker guard missing: ${required}`);
}

const storageFabric = read("lib/resources/storage-fabric.ts");
for (const required of [
  'STORAGE_FABRIC_CONTRACT_VERSION = "1.0.0"',
  "authoritative-primary",
  "home-cannot-hold-sole-authoritative-copy",
  "Production authoritative state cannot depend only on HOME storage",
  "distinct failure domains"
]) {
  if (!storageFabric.includes(required)) fail(`Phase 36 storage authority guard missing: ${required}`);
}

const resilience = read("lib/resources/resilience.ts");
for (const required of [
  'RESILIENCE_CONTRACT_VERSION = "1.0.0"',
  "circuitBreaker",
  "beginDrain",
  "createFailoverPlan",
  "requiresIndependentVerification: true",
  "Failover cannot claim recovery without verified receipt"
]) {
  if (!resilience.includes(required)) fail(`Phase 37 resilience guard missing: ${required}`);
}

const resourceAdapterSdk = read("lib/resources/adapter-sdk.ts");
for (const required of [
  'RESOURCE_ADAPTER_SDK_CONTRACT_VERSION = "1.0.0"',
  "discover(context",
  "authenticate(context",
  "capabilities(context",
  "reserve(context",
  "dispatch(context",
  "authoritative: false",
  "assertResourceAdapterConformance"
]) {
  if (!resourceAdapterSdk.includes(required)) fail(`Phase 38 Resource Adapter SDK guard missing: ${required}`);
}

const pools = read("lib/resources/pools.ts");
for (const required of [
  'RESOURCE_POOL_CONTRACT_VERSION = "1.0.0"',
  "credentialBindingIds",
  "failureDomainIds",
  "autoSchedulingEnabled",
  "evaluateResourcePoolReadiness",
  "assertResourcePoolEligible",
  "buildResourcePoolReadModel"
]) {
  if (!pools.includes(required)) fail(`Phase 39 ResourcePool guard missing: ${required}`);
}

const phase44 = read("lib/security/phase44-adversarial-harness.ts");
for (const required of [
  'PHASE44_DETERMINISTIC_HARNESS_VERSION = "1.0.0"',
  "voice-approval-bypass",
  "staging-production-scope-misuse",
  "forged-resource-capability",
  "reservation-replay",
  "scheduler-bypass",
  "provider-success-spoofing",
  "credential-scope-escalation",
  "cross-company-contamination",
  "release-registry-tampering",
  "model-provider-authority-attempt"
]) {
  if (!phase44.includes(required)) fail(`Phase 44 deterministic adversarial vector missing: ${required}`);
}

const voice = read("lib/voice/voice-intents.ts");
for (const required of [
  "usesControlApi: true",
  "usesCurrentPolicyRegistry: true",
  "canApprove: false",
  "canStepUp: false",
  "canExecuteSideEffect: false",
  "canAcceptRawCredentials: false",
  'strongApprovalHandling: "secure-phone-only"',
  'credentialHandling: "secure-provider-or-phone-only"'
]) {
  if (!voice.includes(required)) fail(`Phase 42 voice authority binding missing: ${required}`);
}

const sourceTrust = read("lib/verification/source-trust.ts");
for (const required of [
  "VerificationSourceBinding",
  "independenceDomain",
  "createVerificationTrustAttestation",
  "assertVerificationTrustAttestation"
]) {
  if (!sourceTrust.includes(required)) fail(`Verification source trust contract missing: ${required}`);
}

const ci = read(".github/workflows/ci.yml");
for (const requiredScript of [
  "npm run verify:architecture",
  "npm run verify:coverage",
  "npm run verify:contract-versions",
  "npm run release:generate",
  "npm run verify:release",
  "actions/upload-artifact@v4"
]) {
  if (!ci.includes(requiredScript)) fail(`CI does not preserve required architecture/release gate: ${requiredScript}`);
}

const releaseRegistry = JSON.parse(read("release/version-registry.json"));
const releaseEnvironment = JSON.parse(read("release/environment-manifest.json"));
for (const required of [
  "registrySchemaVersion",
  "registryVersion",
  "appVersion",
  "environmentManifestSchemaVersion",
  "schemaVersions",
  "database",
  "policy",
  "aiGateway",
  "integrations",
  "execution",
  "resourceFabric",
  "phase44",
  "voice",
  "adapters",
  "environmentManifestPath",
  "acceptanceEvidencePaths",
  "manualSourcePaths",
  "generatedArtifacts"
]) {
  if (!(required in releaseRegistry)) fail(`Phase 41 version registry is missing: ${required}`);
}
if (
  releaseRegistry.appVersion !== packageJson.version
  || releaseRegistry.environmentManifestPath !== "release/environment-manifest.json"
  || releaseRegistry.environmentManifestSchemaVersion !== releaseEnvironment.manifestSchemaVersion
) {
  fail("Phase 41 registry app/environment binding drifted");
}
if (
  releaseRegistry.aiGateway.status !== "not-connected"
  || releaseRegistry.aiGateway.adapterVersion !== "UNIMPLEMENTED"
  || releaseRegistry.aiGateway.contractVersion !== "1.0.0"
  || releaseRegistry.aiGateway.routingPolicyContractVersion !== "1.0.0"
) {
  fail("Phase 13 release state must distinguish deterministic gateway contracts from an unconnected live adapter");
}
if (
  releaseRegistry.integrations.registryContractVersion !== "1.0.0"
  || releaseRegistry.integrations.liveAdaptersStatus !== "not-connected"
) {
  fail("Phase 4 release state drifted");
}
if (
  releaseRegistry.execution.jobRuntimeContractVersion !== "1.0.0"
  || releaseRegistry.execution.durableJobStoreStatus !== "not-connected"
  || releaseRegistry.execution.businessActionContractVersion !== "1.0.0"
  || releaseRegistry.execution.businessAdaptersStatus !== "not-connected"
  || releaseRegistry.execution.softwareWorkerContractVersion !== "1.0.0"
  || releaseRegistry.execution.softwareDeploymentStatus !== "not-connected"
) {
  fail("Phases 19-21 release state drifted");
}
if (
  releaseRegistry.resourceFabric?.storageFabricContractVersion !== "1.0.0"
  || releaseRegistry.resourceFabric?.storageRuntimeStatus !== "not-connected"
  || releaseRegistry.resourceFabric?.resilienceContractVersion !== "1.0.0"
  || releaseRegistry.resourceFabric?.failoverRuntimeStatus !== "not-connected"
  || releaseRegistry.resourceFabric?.resourceAdapterSdkContractVersion !== "1.0.0"
  || releaseRegistry.resourceFabric?.secondProviderStatus !== "not-connected"
  || releaseRegistry.resourceFabric?.resourcePoolContractVersion !== "1.0.0"
  || releaseRegistry.resourceFabric?.partnerPoolRuntimeStatus !== "not-connected"
  || releaseRegistry.adapters?.resourceAdapterSdk?.status !== "contract-only"
) {
  fail("Phases 36-39 release state drifted");
}
if (
  releaseRegistry.phase44?.deterministicHarnessVersion !== "1.0.0"
  || releaseRegistry.phase44?.deterministicHarnessStatus !== "contract-and-offline-tests"
  || releaseRegistry.phase44?.productionAcceptanceStatus !== "not-run"
) {
  fail("Phase 44 deterministic/live acceptance state drifted");
}
if (
  releaseRegistry.voice?.strongApprovalHandling !== "secure-phone-only"
  || releaseRegistry.voice?.credentialHandling !== "secure-provider-or-phone-only"
) {
  fail("Phase 42 voice release registry weakens authority");
}

for (const [name, state] of Object.entries(releaseEnvironment.environments ?? {})) {
  if (
    state.connections?.aiGateway !== false
    || state.aiGateway?.contractStatus !== "deterministic-contract"
    || state.aiGateway?.adapterStatus !== "not-connected"
    || state.integrations?.registryStatus !== "deterministic-contract"
    || state.execution?.jobRuntimeContractStatus !== "deterministic-contract"
    || state.execution?.durableJobStoreStatus !== "not-connected"
    || state.execution?.businessActionAdapterStatus !== "not-connected"
    || state.execution?.softwareDeploymentStatus !== "not-connected"
    || state.resourceFabric?.storageFabricContractStatus !== "deterministic-contract"
    || state.resourceFabric?.storageRuntimeStatus !== "not-connected"
    || state.resourceFabric?.resilienceContractStatus !== "deterministic-contract"
    || state.resourceFabric?.failoverRuntimeStatus !== "not-connected"
    || state.resourceFabric?.resourceAdapterSdkStatus !== "deterministic-contract"
    || state.resourceFabric?.secondProviderStatus !== "not-connected"
    || state.resourceFabric?.resourcePoolContractStatus !== "deterministic-contract"
    || state.resourceFabric?.partnerPoolRuntimeStatus !== "not-connected"
    || state.phase44?.deterministicHarnessStatus !== "offline-blocking-suite"
    || state.phase44?.productionAcceptanceStatus !== "not-run"
  ) {
    fail(`Deterministic/live environment boundary drifted: ${name}`);
  }
  if (
    state.connections?.voiceAdapter !== false
    || state.voice?.strongApprovalAllowed !== false
    || state.voice?.rawCredentialInputAllowed !== false
  ) {
    fail(`Phase 42 voice environment state drifted: ${name}`);
  }
}

if (failures.length > 0) {
  console.error("GetDone architecture integrity verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`GetDone architecture integrity verification passed with ${matrix.rules.length} dependency-boundary rules.`);
