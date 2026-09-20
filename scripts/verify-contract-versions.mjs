import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const registryPath = "release/version-registry.json";
const currentRegistry = JSON.parse(fs.readFileSync(path.join(root, registryPath), "utf8"));
const failures = [];

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function semanticVersion(value) {
  return /^\d+\.\d+\.\d+$/.test(value);
}
function git(args, options = {}) {
  const output = execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return options.preserveOutput ? output : output.trim();
}
function baseRef() {
  if (process.env.GITHUB_BASE_REF) {
    try { return git(["merge-base", "HEAD", `origin/${process.env.GITHUB_BASE_REF}`]); } catch {}
  }
  try { return git(["rev-parse", "HEAD^"]); } catch { return null; }
}
function readAt(ref, relativePath) {
  try {
    return git(["show", `${ref}:${relativePath}`], { preserveOutput: true });
  } catch {
    return null;
  }
}
function sources(entry) {
  if (Array.isArray(entry.contractSourcePaths)) return entry.contractSourcePaths;
  if (entry.contractTracked && entry.sourcePath) return [entry.sourcePath];
  return [];
}
function aggregateCurrent(paths) {
  return sha(paths.map((p) => `${p}\n${fs.readFileSync(path.join(root,p),"utf8")}`).join("\n---\n"));
}
function aggregateAt(ref, paths) {
  const chunks = [];
  for (const p of paths) {
    const value = readAt(ref, p);
    if (value === null) return null;
    chunks.push(`${p}\n${value}`);
  }
  return sha(chunks.join("\n---\n"));
}

const tracked = [];
for (const [groupName, group] of Object.entries({
  schemaVersions: currentRegistry.schemaVersions ?? {},
  adapters: currentRegistry.adapters ?? {}
})) {
  for (const [name, entry] of Object.entries(group)) {
    if (!entry.contractTracked) continue;
    const contractSources = sources(entry);
    if (!semanticVersion(entry.version)) failures.push(`${groupName}.${name} contract version must be semver`);
    for (const source of contractSources) {
      if (!fs.existsSync(path.join(root, source))) failures.push(`${groupName}.${name} contract source missing: ${source}`);
    }
    tracked.push({ groupName, name, entry, contractSources });
  }
}

const base = baseRef();
if (base) {
  const previousRegistryRaw = readAt(base, registryPath);
  if (previousRegistryRaw) {
    const previousRegistry = JSON.parse(previousRegistryRaw);
    for (const item of tracked) {
      const previousEntry = previousRegistry[item.groupName]?.[item.name];
      if (!previousEntry?.contractTracked) continue;
      const previousSources = sources(previousEntry);
      const before = aggregateAt(base, previousSources);
      const after = aggregateCurrent(item.contractSources);
      if (before && before !== after && previousEntry.version === item.entry.version) {
        failures.push(
          `${item.groupName}.${item.name} contract changed without a version bump (still ${item.entry.version})`
        );
      }
    }
  }
}

if (failures.length) {
  console.error("GetDone contract-version drift verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`GetDone contract-version drift verification passed for ${tracked.length} tracked contracts.`);
