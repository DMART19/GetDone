import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  deployVercelStaging,
  ensureVercelProjectLink,
  pointVercelStagingAlias,
  stagingAliasOrigin,
  VERCEL_SOFTWARE_DEPLOYMENT_EXECUTOR_VERSION
} from "./vercel-software-deployment-executor.mjs";

const VERSION = "1.0.0";
const root = process.cwd();
const outDir = path.join(root, "test-results");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function canonicalSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalSerialize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hashValue(value) {
  return createHash("sha256").update(canonicalSerialize(value)).digest("hex");
}

function hashBody(value) {
  return createHash("sha256").update(value).digest("hex");
}

function providerEvidence(deployment, sourceCommitSha) {
  const base = {
    provider: "vercel",
    target: "staging",
    deploymentReference: deployment.deploymentReference,
    deploymentUrl: deployment.deploymentUrl,
    sourceCommitSha,
    acceptedAt: deployment.acceptedAt,
    providerState: "READY",
    authoritativeSuccess: false
  };
  return { ...base, evidenceHash: hashValue(base) };
}

function rollbackEvidence(input) {
  const base = {
    provider: "vercel",
    target: "staging",
    alias: input.alias,
    fromDeploymentReference: input.fromDeploymentReference,
    toDeploymentReference: input.toDeploymentReference,
    acceptedAt: input.acceptedAt,
    providerAccepted: true,
    authoritativeRecovery: false
  };
  return { ...base, evidenceHash: hashValue(base) };
}

function verificationEvidence({ kind, url, status, ok, observedAt, body }) {
  const base = {
    source: "independent-http-verifier",
    kind,
    url,
    status,
    ok,
    observedAt,
    responseHash: hashBody(body)
  };
  return { ...base, evidenceHash: hashValue(base) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sample(url, kind, headers) {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "follow",
      cache: "no-store"
    });
    const body = await response.text();
    let ok = response.ok;

    if (kind === "health") {
      try {
        const parsed = JSON.parse(body);
        ok = ok && parsed?.ok === true && parsed?.data?.status === "ok";
      } catch {
        ok = false;
      }
    } else {
      ok = ok && body.includes("How can I") && body.includes("move things forward");
    }

    return verificationEvidence({
      kind,
      url,
      status: response.status,
      ok,
      observedAt: new Date().toISOString(),
      body
    });
  } catch (error) {
    return verificationEvidence({
      kind,
      url,
      status: 599,
      ok: false,
      observedAt: new Date().toISOString(),
      body: error instanceof Error ? error.message : "fetch failed"
    });
  }
}

async function waitForExpectation(url, kind, expectedOk, headers) {
  let last;
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    last = await sample(url, kind, headers);
    if (last.ok === expectedOk) return last;
    await sleep(2_000);
  }
  return last;
}

function assertOk(evidence, label) {
  if (!evidence?.ok) {
    throw new Error(
      `${label} independent verification failed with HTTP ${evidence?.status ?? "unknown"}`
    );
  }
}

async function persist(run) {
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, "software-deployment-acceptance.json"),
    JSON.stringify(run, null, 2) + "\n",
    "utf8"
  );

  const markdown = `# Software deployment staging acceptance

- Status: **${run.status.toUpperCase()}**
- Provider: Vercel custom environment \`staging\`
- Source commit: \`${run.sourceCommitSha}\`
- Good deployment: \`${run.goodDeployment.deploymentReference}\`
- Controlled bad deployment: \`${run.badDeployment.deploymentReference}\`
- Failed verification detected: **${run.badVerification.some((item) => !item.ok) ? "yes" : "no"}**
- Rollback provider acceptance: \`${run.rollback.fromDeploymentReference}\` → \`${run.rollback.toDeploymentReference}\`
- Recovery independently verified: **${run.recoveryVerification.every((item) => item.ok) ? "yes" : "no"}**
- Provider READY is authoritative success: **no**
- Lineage hash: \`${run.lineageHash}\`
- Completed: ${run.completedAt}
`;
  await writeFile(
    path.join(outDir, "software-deployment-acceptance.md"),
    markdown,
    "utf8"
  );
}

const token = required("VERCEL_TOKEN");
const orgId = required("VERCEL_ORG_ID");
const projectId = required("VERCEL_PROJECT_ID");
const alias = required("VERCEL_STAGING_ALIAS");
const scope = process.env.VERCEL_SCOPE?.trim();
const sourceCommitSha =
  process.env.GITHUB_SHA?.trim() || required("GETDONE_ACCEPTANCE_SOURCE_COMMIT");
const runId = [
  "software-deployment",
  process.env.GITHUB_RUN_ID || Date.now(),
  process.env.GITHUB_RUN_ATTEMPT || "1"
].join("-");
const startedAt = new Date().toISOString();

const headers = {};
if (process.env.VERCEL_STAGING_BYPASS_TOKEN?.trim()) {
  headers["x-vercel-protection-bypass"] =
    process.env.VERCEL_STAGING_BYPASS_TOKEN.trim();
}

await ensureVercelProjectLink({ orgId, projectId });

let goodDeployment;
let badDeployment;
let rollback;
let goodVerification = [];
let badVerification = [];
let recoveryVerification = [];
let badAliasAssigned = false;

try {
  goodDeployment = providerEvidence(
    deployVercelStaging({
      token,
      scope,
      mode: "healthy",
      runId,
      phase: "known-good",
      sourceCommitSha
    }),
    sourceCommitSha
  );

  pointVercelStagingAlias({
    token,
    scope,
    alias,
    deploymentUrl: goodDeployment.deploymentUrl
  });

  const origin = stagingAliasOrigin(alias);
  goodVerification = [
    await waitForExpectation(`${origin}/api/health`, "health", true, headers),
    await waitForExpectation(`${origin}/`, "business", true, headers)
  ];
  assertOk(goodVerification[0], "Known-good health");
  assertOk(goodVerification[1], "Known-good business");

  badDeployment = providerEvidence(
    deployVercelStaging({
      token,
      scope,
      mode: "force-unhealthy",
      runId,
      phase: "controlled-bad",
      sourceCommitSha
    }),
    sourceCommitSha
  );

  pointVercelStagingAlias({
    token,
    scope,
    alias,
    deploymentUrl: badDeployment.deploymentUrl
  });
  badAliasAssigned = true;

  badVerification = [
    await waitForExpectation(`${origin}/api/health`, "health", false, headers),
    await sample(`${origin}/`, "business", headers)
  ];

  if (!badVerification.some((item) => !item.ok)) {
    throw new Error(
      "Controlled bad deployment was not detected by independent verification"
    );
  }

  const rollbackAcceptance = pointVercelStagingAlias({
    token,
    scope,
    alias,
    deploymentUrl: goodDeployment.deploymentUrl
  });
  badAliasAssigned = false;

  rollback = rollbackEvidence({
    alias: rollbackAcceptance.alias,
    acceptedAt: rollbackAcceptance.acceptedAt,
    fromDeploymentReference: badDeployment.deploymentReference,
    toDeploymentReference: goodDeployment.deploymentReference
  });

  recoveryVerification = [
    await waitForExpectation(`${origin}/api/health`, "health", true, headers),
    await waitForExpectation(`${origin}/`, "business", true, headers)
  ];
  assertOk(recoveryVerification[0], "Rollback recovery health");
  assertOk(recoveryVerification[1], "Rollback recovery business");

  const base = {
    version: VERSION,
    runId,
    repository: "DMART19/GetDone",
    sourceCommitSha,
    startedAt,
    completedAt: new Date().toISOString(),
    goodDeployment,
    goodVerification,
    badDeployment,
    badVerification,
    rollback,
    recoveryVerification,
    status: "passed"
  };
  const run = { ...base, lineageHash: hashValue(base) };

  await persist(run);

  console.log(JSON.stringify({
    status: run.status,
    runId: run.runId,
    executorVersion: VERCEL_SOFTWARE_DEPLOYMENT_EXECUTOR_VERSION,
    lineageHash: run.lineageHash,
    providerAcceptedButNotAuthoritative: true,
    recoveryVerified: true
  }, null, 2));
} catch (error) {
  if (badAliasAssigned && goodDeployment) {
    try {
      pointVercelStagingAlias({
        token,
        scope,
        alias,
        deploymentUrl: goodDeployment.deploymentUrl
      });
    } catch {
      // Preserve the original acceptance failure. Operator review is still required.
    }
  }
  throw error;
}
