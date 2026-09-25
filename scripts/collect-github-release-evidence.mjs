import fs from "node:fs";
import path from "node:path";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const token = required("GITHUB_TOKEN");
const repository = required("GITHUB_REPOSITORY");
const candidateSha = required("GETDONE_RELEASE_CANDIDATE_SHA");
if (!/^[a-f0-9]{40}$/.test(candidateSha)) {
  throw new Error("GETDONE_RELEASE_CANDIDATE_SHA must be an exact 40-character commit SHA");
}

const requiredWorkflows = ["CI","PostgreSQL Integration"];
const response = await fetch(
  `https://api.github.com/repos/${repository}/actions/runs?head_sha=${candidateSha}&per_page=100`,
  {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28"
    }
  }
);
if (!response.ok) {
  throw new Error(`GitHub Actions evidence lookup failed with HTTP ${response.status}`);
}
const body = await response.json();
const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
const checks = [];
for (const name of requiredWorkflows) {
  const matching = runs
    .filter((run) => run.name === name && run.head_sha === candidateSha)
    .sort((a,b) => Date.parse(b.updated_at ?? b.created_at) - Date.parse(a.updated_at ?? a.created_at));
  const run = matching[0];
  if (!run || run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(
      `Required exact-SHA workflow is not green: ${name} for ${candidateSha}`
    );
  }
  checks.push({
    name,
    runId: run.id,
    runNumber: run.run_number,
    status: run.status,
    conclusion: run.conclusion,
    headSha: run.head_sha,
    event: run.event,
    createdAt: run.created_at,
    updatedAt: run.updated_at
  });
}

const evidence = {
  schemaVersion:"1.0.0",
  repository,
  candidateSha,
  collectedAt:new Date().toISOString(),
  checks
};
const out = path.resolve(
  process.env.GETDONE_GITHUB_RELEASE_EVIDENCE_PATH?.trim()
    || "test-results/production-gate/github-evidence.json"
);
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out,JSON.stringify(evidence,null,2)+"\n");
console.log(JSON.stringify(evidence,null,2));
