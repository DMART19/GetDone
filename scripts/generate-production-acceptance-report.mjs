import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "release", "out");
const testResultsDir = path.join(root, "test-results");

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function listJsonFiles(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await listJsonFiles(full));
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(full);
    }
    return files;
  } catch {
    return [];
  }
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function latestTimestamp(value) {
  const found = [];
  const visit = (item, key = "") => {
    if (Array.isArray(item)) {
      item.forEach((child) => visit(child, key));
      return;
    }
    if (!item || typeof item !== "object") {
      if (
        typeof item === "string"
        && /(At|Date|timestamp)$/i.test(key)
        && Number.isFinite(Date.parse(item))
      ) {
        found.push(new Date(item).toISOString());
      }
      return;
    }
    for (const [childKey, child] of Object.entries(item)) visit(child, childKey);
  };
  visit(value);
  return found.sort().at(-1) || null;
}

function disconnected(status) {
  const value = String(status ?? "").toLowerCase();
  return (
    !value
    || value.includes("not-connected")
    || value.includes("unconnected")
    || value.includes("unconfigured")
    || value.includes("development-only")
    || value.includes("not-run")
    || value.includes("simulation-only")
    || value === "unimplemented"
  );
}

function evidenceStatus(payload) {
  if (typeof payload?.status === "string") return payload.status;
  if (payload?.ok === true) return "passed";
  if (payload?.ok === false) return "failed";
  return "evidence-recorded";
}

const registry = await readJson(path.join(root, "release", "version-registry.json"));
if (!registry) {
  throw new Error("release/version-registry.json is required");
}

const evidenceFiles = await listJsonFiles(testResultsDir);
const liveTests = [];
for (const file of evidenceFiles) {
  if (
    !/staging-acceptance\.json$/.test(file)
    && !/software-deployment-acceptance\.json$/.test(file)
  ) {
    continue;
  }
  const payload = await readJson(file);
  if (!payload) continue;
  liveTests.push({
    area: path.basename(file, ".json"),
    status: evidenceStatus(payload),
    lastTestedAt: latestTimestamp(payload),
    evidencePath: relative(file)
  });
}
liveTests.sort((a, b) =>
  String(b.lastTestedAt ?? "").localeCompare(String(a.lastTestedAt ?? ""))
);

const software = await readJson(
  path.join(testResultsDir, "software-deployment-acceptance.json")
);
const softwarePassed = Boolean(
  software?.status === "passed"
  && Array.isArray(software?.goodVerification)
  && software.goodVerification.length >= 2
  && software.goodVerification.every((item) => item.ok === true)
  && Array.isArray(software?.badVerification)
  && software.badVerification.some((item) => item.ok === false)
  && Array.isArray(software?.recoveryVerification)
  && software.recoveryVerification.length >= 2
  && software.recoveryVerification.every((item) => item.ok === true)
  && software?.rollback?.providerAccepted === true
  && software?.rollback?.authoritativeRecovery === false
  && typeof software?.lineageHash === "string"
);

const connected = [];
if (softwarePassed) {
  connected.push({
    component: "Software deployment staging target",
    status: "live-accepted",
    detail:
      "Vercel custom staging target passed independent health/business verification and rollback recovery.",
    evidencePath: "test-results/software-deployment-acceptance.json"
  });
}

const snapshots = [
  ["Authoritative database", registry.database?.status],
  ["AI gateway", registry.aiGateway?.status],
  ["Live business integrations", registry.integrations?.liveAdaptersStatus],
  ["Durable Job store", registry.execution?.durableJobStoreStatus],
  ["Production software deployment", registry.execution?.softwareDeploymentStatus],
  ["Control API application adapter", registry.controlApi?.applicationAdapterStatus],
  ["Control API authentication", registry.controlApi?.authStatus],
  ["Control API persistence", registry.controlApi?.persistenceStatus],
  ["Voice adapter", registry.voice?.adapterStatus]
];

for (const [component, status] of snapshots) {
  if (!disconnected(status)) {
    connected.push({
      component,
      status,
      detail: "Release registry reports this component connected."
    });
  }
}

const blocked = [];
const requireConnected = (component, status) => {
  if (disconnected(status)) {
    blocked.push({
      component,
      reason: `Release registry status is ${status ?? "missing"}.`
    });
  }
};

requireConnected("Authoritative database", registry.database?.status);
requireConnected("AI gateway", registry.aiGateway?.status);
requireConnected("Live business integrations", registry.integrations?.liveAdaptersStatus);
requireConnected("Durable Job store", registry.execution?.durableJobStoreStatus);
requireConnected("Production software deployment", registry.execution?.softwareDeploymentStatus);
requireConnected(
  "Control API application adapter",
  registry.controlApi?.applicationAdapterStatus
);
requireConnected("Control API authentication", registry.controlApi?.authStatus);
requireConnected("Control API persistence", registry.controlApi?.persistenceStatus);

if (registry.voice?.requiredForProduction === true) {
  requireConnected("Voice adapter", registry.voice?.adapterStatus);
}

if (!softwarePassed) {
  blocked.push({
    component: "Software staging deployment acceptance",
    reason:
      "No passed live deployment + controlled failure + rollback recovery evidence is present in this evidence bundle."
  });
}

if (registry.phase44?.productionAcceptanceStatus !== "passed") {
  blocked.push({
    component: "Adversarial production acceptance",
    reason:
      `Phase 44 production acceptance status is ${registry.phase44?.productionAcceptanceStatus ?? "missing"}.`
  });
}

if (registry.composition?.productionExecutionClaimed !== true) {
  blocked.push({
    component: "End-to-end production execution",
    reason: "The release registry does not claim production execution."
  });
}

const lastLiveTestedAt =
  liveTests
    .map((entry) => entry.lastTestedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;

const softwareDeploymentAcceptance = software
  ? {
      status: software.status ?? "unknown",
      provider: software.goodDeployment?.provider ?? "vercel",
      target: software.goodDeployment?.target ?? "staging",
      runId: software.runId ?? null,
      sourceCommitSha: software.sourceCommitSha ?? null,
      goodDeploymentReference:
        software.goodDeployment?.deploymentReference ?? null,
      badDeploymentReference:
        software.badDeployment?.deploymentReference ?? null,
      rollbackFromDeploymentReference:
        software.rollback?.fromDeploymentReference ?? null,
      rollbackToDeploymentReference:
        software.rollback?.toDeploymentReference ?? null,
      failedVerificationDetected: Boolean(
        software.badVerification?.some?.((item) => item.ok === false)
      ),
      recoveryVerified: Boolean(
        software.recoveryVerification?.length
        && software.recoveryVerification.every((item) => item.ok === true)
      ),
      completedAt: software.completedAt ?? null,
      lineageHash: software.lineageHash ?? null
    }
  : null;

const report = {
  schemaVersion: "1.0.0",
  generatedAt: new Date().toISOString(),
  repository: "DMART19/GetDone",
  connected,
  testedLive: liveTests,
  lastLiveTestedAt,
  blocked,
  eligibleForProductionPromotion: blocked.length === 0,
  softwareDeploymentAcceptance
};

await mkdir(outDir, { recursive: true });

await writeFile(
  path.join(outDir, "production-acceptance-report.json"),
  JSON.stringify(report, null, 2) + "\n",
  "utf8"
);

const lines = [
  "# GetDone production acceptance report",
  "",
  `**Production promotion:** ${report.eligibleForProductionPromotion ? "ELIGIBLE" : "BLOCKED"}`,
  `**Generated:** ${report.generatedAt}`,
  `**Last live test:** ${report.lastLiveTestedAt ?? "No live acceptance evidence in this bundle"}`,
  "",
  "## What is connected",
  ...(report.connected.length
    ? report.connected.map(
        (item) => `- **${item.component}** — ${item.status}. ${item.detail}`
      )
    : [
        "- No component in this evidence bundle is currently proven connected by the release registry/live evidence."
      ]),
  "",
  "## What was tested live",
  ...(report.testedLive.length
    ? report.testedLive.map(
        (item) =>
          `- **${item.area}** — ${item.status}; last evidence ${item.lastTestedAt ?? "timestamp unavailable"}; \`${item.evidencePath}\``
      )
    : ["- No live staging acceptance JSON was available to this report run."]),
  "",
  "## Software deployment / rollback",
  ...(softwareDeploymentAcceptance
    ? [
        `- Status: **${softwareDeploymentAcceptance.status}**`,
        `- Known-good deployment: \`${softwareDeploymentAcceptance.goodDeploymentReference}\``,
        `- Controlled bad deployment: \`${softwareDeploymentAcceptance.badDeploymentReference}\``,
        `- Failed independent verification detected: **${softwareDeploymentAcceptance.failedVerificationDetected ? "yes" : "no"}**`,
        `- Rollback: \`${softwareDeploymentAcceptance.rollbackFromDeploymentReference}\` → \`${softwareDeploymentAcceptance.rollbackToDeploymentReference}\``,
        `- Recovery independently verified: **${softwareDeploymentAcceptance.recoveryVerified ? "yes" : "no"}**`,
        `- Lineage hash: \`${softwareDeploymentAcceptance.lineageHash}\``
      ]
    : [
        "- Live staging deployment/rollback acceptance has not been recorded in this evidence bundle."
      ]),
  "",
  "## What remains blocked",
  ...(report.blocked.length
    ? report.blocked.map(
        (item) => `- **${item.component}** — ${item.reason}`
      )
    : ["- Nothing in the configured production acceptance gate remains blocked."]),
  "",
  "## Promotion decision",
  report.eligibleForProductionPromotion
    ? "GetDone has the required connected/live evidence in this report and is eligible to enter the existing owner production-promotion approval boundary."
    : "GetDone is not currently eligible for production promotion. The owner approval boundary remains closed until every blocker above has real evidence.",
  ""
];

await writeFile(
  path.join(outDir, "PRODUCTION_ACCEPTANCE_REPORT.md"),
  lines.join("\n"),
  "utf8"
);

console.log(JSON.stringify({
  eligibleForProductionPromotion: report.eligibleForProductionPromotion,
  lastLiveTestedAt: report.lastLiveTestedAt,
  blockerCount: report.blocked.length,
  machineReport: "release/out/production-acceptance-report.json",
  humanReport: "release/out/PRODUCTION_ACCEPTANCE_REPORT.md"
}, null, 2));
