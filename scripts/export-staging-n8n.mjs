#!/usr/bin/env node
/**
 * Generate a staging-only n8n import bundle without changing authoritative production templates.
 * Run: node scripts/export-staging-n8n.mjs /path/to/empty/output-directory
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const templatesDirectory = fileURLToPath(new URL("../n8n/", import.meta.url));
const workflowNames = ["github_repository_health", "deployment_health", "github_create_branch"];
const productionValidator = "https://getdone-web.onrender.com/api/integrations/n8n/validate";
const stagingValidator = "https://getdone-web-staging.onrender.com/api/integrations/n8n/validate";

function generate(name) {
  const source = JSON.parse(readFileSync(join(templatesDirectory, name + ".json"), "utf8"));
  const guard = source.nodes?.find((node) => node.id === "guard");
  const webhook = source.nodes?.find((node) => node.id === "trigger");
  const receipt = source.nodes?.find((node) => node.id === "receipt");

  if (source.name !== name || source.active !== false ||
      guard?.type !== "n8n-nodes-base.httpRequest" ||
      guard.parameters?.method !== "POST" ||
      guard.parameters?.url !== productionValidator ||
      webhook?.type !== "n8n-nodes-base.webhook" ||
      webhook.parameters?.path !== "getdone-" + name ||
      typeof receipt?.parameters?.jsCode !== "string") {
    throw new Error("n8n template contract changed; refusing to export staging workflow: " + name);
  }
  const receiptCode = receipt.parameters.jsCode;
  for (const variant of ["github_create_branch", "deployment_health"]) {
    if (!receiptCode.includes("$workflow.name==='" + variant + "'")) {
      throw new Error("n8n receipt workflow dispatch changed; refusing staging export: " + name);
    }
  }

  // Distinct paths avoid colliding with production webhooks on the same n8n instance.
  source.name = "getdone-staging-" + name;
  source.active = false;
  webhook.parameters.path = "getdone-staging-" + name;
  guard.parameters.url = stagingValidator;
  receipt.parameters.jsCode = receiptCode
    .replaceAll("$workflow.name==='github_create_branch'",
      "$workflow.name==='getdone-staging-github_create_branch'")
    .replaceAll("$workflow.name==='deployment_health'",
      "$workflow.name==='getdone-staging-deployment_health'");

  if (JSON.stringify(source).includes(productionValidator)) {
    throw new Error("Production validator leaked into staging export: " + name);
  }
  return source;
}

if (process.argv.length !== 3) {
  throw new Error("Provide an empty output directory: node scripts/export-staging-n8n.mjs /path/to/output");
}
const outputDir = resolve(process.argv[2]);
if (outputDir === resolve(templatesDirectory)) {
  throw new Error("Refusing to overwrite authoritative n8n templates");
}
if (existsSync(outputDir) && workflowNames.some(name => existsSync(join(outputDir, name + ".json")))) {
  throw new Error("Destination has existing workflow files; use a fresh output directory");
}

// Validate all templates before creating any output.
const workflows = workflowNames.map(name => ({ name, source: generate(name) }));
mkdirSync(outputDir, { recursive: true });
for (const { name, source } of workflows) {
  const destination = join(outputDir, name + ".json");
  writeFileSync(destination, JSON.stringify(source, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log("Prepared inactive staging workflow:", name);
}
