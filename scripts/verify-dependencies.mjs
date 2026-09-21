import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "coverage", "security");
fs.mkdirSync(outDir, { recursive: true });

function runAudit(name, args, outputFile) {
  let raw = "";
  let exitCode = 0;
  try {
    raw = execFileSync("npm", ["audit", "--json", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    exitCode = typeof error?.status === "number" ? error.status : 1;
    raw = String(error?.stdout ?? "");
    if (!raw.trim()) {
      throw new Error(`npm audit did not return JSON for ${name}; dependency audit is unavailable`);
    }
  }

  const parsed = JSON.parse(raw);
  const vulnerabilities = parsed.metadata?.vulnerabilities ?? {};
  const evidence = {
    schemaVersion: "1.0.0",
    audit: name,
    generatedAt: new Date().toISOString(),
    npmVersion: execFileSync("npm", ["--version"], { cwd: root, encoding: "utf8" }).trim(),
    vulnerabilityCounts: {
      info: vulnerabilities.info ?? 0,
      low: vulnerabilities.low ?? 0,
      moderate: vulnerabilities.moderate ?? 0,
      high: vulnerabilities.high ?? 0,
      critical: vulnerabilities.critical ?? 0,
      total: vulnerabilities.total ?? 0
    },
    dependencyCounts: parsed.metadata?.dependencies ?? {},
    policyExitCode: exitCode
  };

  fs.writeFileSync(path.join(outDir, outputFile), JSON.stringify(evidence, null, 2) + "\n");

  if (exitCode !== 0) {
    throw new Error(
      `${name} dependency audit failed policy: high=${evidence.vulnerabilityCounts.high}, critical=${evidence.vulnerabilityCounts.critical}`
    );
  }
}

runAudit(
  "production-high",
  ["--omit=dev", "--audit-level=high"],
  "npm-audit-production.json"
);
runAudit(
  "full-critical",
  ["--audit-level=critical"],
  "npm-audit-full-critical.json"
);

console.log("Dependency audit passed: production high/critical=0 and full dependency graph critical=0.");
