import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const allowedExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".yml", ".yaml", ".css"]);
const ignoredDirectories = new Set([".git", ".next", "node_modules", "coverage"]);
const ignoredFiles = new Set(["package-lock.json"]);

const secretPatterns = [
  { label: "OpenAI-style secret key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: "GitHub personal access token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "Private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g }
];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".env") && entry.name !== ".env.example") {
      throw new Error(`Secret-bearing environment file must not be committed: ${relative(root, join(directory, entry.name))}`);
    }

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...await walk(join(directory, entry.name)));
      continue;
    }

    if (ignoredFiles.has(entry.name) || !allowedExtensions.has(extname(entry.name))) continue;
    files.push(join(directory, entry.name));
  }

  return files;
}

const findings = [];
for (const file of await walk(root)) {
  const source = await readFile(file, "utf8");
  for (const { label, pattern } of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(source)) findings.push(`${relative(root, file)}: ${label}`);
  }
}

if (findings.length) {
  console.error("Potential committed secrets detected:");
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exit(1);
}

console.log("Secret-pattern scan passed.");
