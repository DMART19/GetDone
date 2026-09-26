import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const VERCEL_SOFTWARE_DEPLOYMENT_EXECUTOR_VERSION = "1.0.0";
const VERCEL_CLI_VERSION = "59.23.1";

function sanitize(value, secret) {
  return secret ? String(value || "").split(secret).join("[redacted]") : String(value || "");
}

function normalizeAlias(alias) {
  const trimmed = alias.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!trimmed || trimmed.includes("/")) {
    throw new Error("VERCEL_STAGING_ALIAS must be a hostname without a path");
  }
  return trimmed;
}

function runVercel(args, { token, scope }) {
  const auth = ["--token", token];
  if (scope?.trim()) auth.push("--scope", scope.trim());

  const result = spawnSync(
    "npx",
    ["--yes", `vercel@${VERCEL_CLI_VERSION}`, ...args, ...auth],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  if (result.status !== 0) {
    const detail = sanitize(result.stderr || result.stdout || "Vercel CLI failed", token)
      .trim()
      .split("\n")
      .slice(-12)
      .join(" | ");
    throw new Error(`Vercel command failed: ${detail}`);
  }
  return result.stdout.trim();
}

export async function ensureVercelProjectLink({ orgId, projectId }) {
  if (!orgId?.trim() || !projectId?.trim()) {
    throw new Error("VERCEL_ORG_ID and VERCEL_PROJECT_ID are required");
  }

  const directory = path.join(process.cwd(), ".vercel");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "project.json"),
    JSON.stringify({ orgId: orgId.trim(), projectId: projectId.trim() }, null, 2) + "\n",
    "utf8"
  );
}

export function deployVercelStaging(input) {
  const output = runVercel([
    "deploy",
    "--target=staging",
    "--yes",
    "--env",
    "GETDONE_RUNTIME_ENV=staging",
    "--env",
    `GETDONE_DEPLOYMENT_ACCEPTANCE_MODE=${input.mode}`,
    "--meta",
    `getdoneAcceptanceRun=${input.runId}`,
    "--meta",
    `getdoneAcceptancePhase=${input.phase}`,
    "--meta",
    `getdoneSourceCommit=${input.sourceCommitSha}`
  ], input);

  const deploymentUrl = output
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => /^https:\/\//.test(value))
    .at(-1);

  if (!deploymentUrl) {
    throw new Error("Vercel accepted the deploy command but did not return a deployment URL");
  }

  return Object.freeze({
    deploymentReference: deploymentUrl,
    deploymentUrl,
    acceptedAt: new Date().toISOString()
  });
}

export function pointVercelStagingAlias(input) {
  const alias = normalizeAlias(input.alias);
  runVercel(["alias", "set", input.deploymentUrl, alias], input);
  return Object.freeze({
    alias,
    acceptedAt: new Date().toISOString()
  });
}

export function stagingAliasOrigin(alias) {
  return `https://${normalizeAlias(alias)}`;
}
