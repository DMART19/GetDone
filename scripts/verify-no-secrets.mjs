import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const allowedExtensions = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".yml", ".yaml",
  ".css", ".txt", ".sh", ".toml", ".xml"
]);
const ignoredFiles = new Set(["package-lock.json"]);
const explicitlyScannedDotfiles = new Set([".npmrc"]);

const secretPatterns = [
  { label: "OpenRouter secret key", pattern: /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/g },
  { label: "OpenAI-style secret key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: "GitHub personal/access token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "Stripe live secret key", pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/g },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { label: "npm auth token", pattern: /(?:^|\n)\s*\/\/[^\n:]+\/:_authToken\s*=\s*[^\s$][^\s]{15,}/g },
  { label: "Bearer credential", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/g },
  { label: "Private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  {
    label: "Secret-like assignment",
    pattern: /\b(?:api[_-]?key|secret|client[_-]?secret|password|access[_-]?token|refresh[_-]?token|service[_-]?role[_-]?key)\b\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{20,}["']/gi
  }
];

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function shouldScan(file) {
  if (ignoredFiles.has(file)) return false;
  if (explicitlyScannedDotfiles.has(file)) return true;
  return allowedExtensions.has(extname(file));
}

const findings = [];
for (const file of trackedFiles()) {
  if (file.startsWith(".env") && file !== ".env.example") {
    findings.push(`${file}: committed environment file`);
    continue;
  }
  if (!shouldScan(file)) continue;

  const source = await readFile(file, "utf8");
  for (const { label, pattern } of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(source)) findings.push(`${file}: ${label}`);
  }
}

if (findings.length) {
  console.error("Potential committed secrets detected:");
  for (const finding of [...new Set(findings)].sort()) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Secret scan passed across ${trackedFiles().length} committed paths.`);
