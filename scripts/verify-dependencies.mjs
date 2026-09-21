import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "coverage", "security");
fs.mkdirSync(outDir, { recursive: true });

function runJson(command, args) {
  try {
    return JSON.parse(execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }));
  } catch (error) {
    const stdout = String(error?.stdout ?? "");
    if (!stdout.trim()) throw error;
    return JSON.parse(stdout);
  }
}

function collectDependencyNames(node, output = new Set()) {
  for (const [name, child] of Object.entries(node?.dependencies ?? {})) {
    output.add(name);
    collectDependencyNames(child, output);
  }
  return output;
}

function normalizedAffected(vulnerabilities, allowedNames) {
  return Object.entries(vulnerabilities ?? {})
    .filter(([packageName]) => !allowedNames || allowedNames.has(packageName))
    .map(([packageName, detail]) => ({
      packageName,
      severity: detail.severity ?? "unknown",
      direct: Boolean(detail.isDirect),
      fixAvailable: Boolean(detail.fixAvailable)
    }))
    .sort((a, b) => a.packageName.localeCompare(b.packageName));
}

function counts(items) {
  const result = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: items.length };
  for (const item of items) {
    if (item.severity in result && item.severity !== "total") result[item.severity] += 1;
  }
  return result;
}

function writeEvidence(file, audit, affectedPackages, dependencyCounts) {
  const evidence = {
    schemaVersion: "1.2.0",
    audit,
    generatedAt: new Date().toISOString(),
    npmVersion: execFileSync("npm", ["--version"], { cwd: root, encoding: "utf8" }).trim(),
    vulnerabilityCounts: counts(affectedPackages),
    dependencyCounts,
    affectedPackages
  };
  fs.writeFileSync(path.join(outDir, file), JSON.stringify(evidence, null, 2) + "\n");
  return evidence;
}

const auditResult = runJson("npm", ["audit", "--json"]);
const productionTree = runJson("npm", ["ls", "--omit=dev", "--all", "--json"]);
const productionNames = collectDependencyNames(productionTree);
const allAffected = normalizedAffected(auditResult.vulnerabilities);
const productionAffected = normalizedAffected(auditResult.vulnerabilities, productionNames);

const production = writeEvidence(
  "npm-audit-production.json",
  "production-high",
  productionAffected,
  productionTree.dependencies ? { topLevel: Object.keys(productionTree.dependencies).length } : {}
);
const full = writeEvidence(
  "npm-audit-full-critical.json",
  "full-critical",
  allAffected,
  auditResult.metadata?.dependencies ?? {}
);

const productionBlocked = productionAffected.filter(
  (item) => item.severity === "high" || item.severity === "critical"
);
const fullCritical = allAffected.filter((item) => item.severity === "critical");

if (productionBlocked.length || fullCritical.length) {
  const describe = (items) => items
    .map((item) => `${item.packageName}[${item.severity}${item.direct ? ",direct" : ""}${item.fixAvailable ? ",fix-available" : ""}]`)
    .join(", ");
  throw new Error(
    [
      `dependency audit failed: production high/critical=${productionBlocked.length}`,
      `full-graph critical=${fullCritical.length}`,
      productionBlocked.length ? `production=${describe(productionBlocked)}` : "",
      fullCritical.length ? `critical=${describe(fullCritical)}` : ""
    ].filter(Boolean).join("; ")
  );
}

console.log(
  `Dependency audit passed: production high/critical=0; full-graph critical=0; visible full-graph findings=${full.vulnerabilityCounts.total}.`
);
