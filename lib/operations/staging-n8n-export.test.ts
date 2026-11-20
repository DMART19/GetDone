import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const names = ["github_repository_health", "deployment_health", "github_create_branch"];
const productionValidator = "https://getdone-web.onrender.com/api/integrations/n8n/validate";
const stagingValidator = "https://getdone-web-staging.onrender.com/api/integrations/n8n/validate";
const exporter = resolve("scripts/export-staging-n8n.mjs");

describe("staging-only n8n workflow export", () => {
  let outputDir: string;
  beforeAll(() => {
    outputDir = mkdtempSync(join(tmpdir(), "getdone-staging-n8n-"));
    execFileSync(process.execPath, [exporter, outputDir], { stdio: "pipe" });
  });
  afterAll(() => {
    if (outputDir) rmSync(outputDir, { recursive: true, force: true });
  });

  it.each(names)("isolates %s from production while retaining the guarded workflow contract", name => {
    const original = JSON.parse(readFileSync(resolve("n8n", name + ".json"), "utf8"));
    const staging = JSON.parse(readFileSync(join(outputDir, name + ".json"), "utf8"));
    const originalGuard = original.nodes.find((node: { id: string }) => node.id === "guard");
    const guard = staging.nodes.find((node: { id: string }) => node.id === "guard");
    const trigger = staging.nodes.find((node: { id: string }) => node.id === "trigger");
    const receipt = staging.nodes.find((node: { id: string }) => node.id === "receipt");

    expect(originalGuard.parameters.url).toBe(productionValidator);
    expect(staging.name).toBe("getdone-staging-" + name);
    expect(staging.active).toBe(false);
    expect(trigger.parameters.path).toBe("getdone-staging-" + name);
    expect(guard.parameters.url).toBe(stagingValidator);
    expect(guard.parameters.method).toBe("POST");
    expect(JSON.stringify(guard)).toContain("X-GetDone-Signature");
    expect(guard.parameters.jsonBody).toBe("={{ $json.body }}");
    expect(JSON.stringify(staging)).not.toContain(productionValidator);
    expect(receipt.parameters.jsCode).toContain("$workflow.name==='getdone-staging-github_create_branch'");
    expect(receipt.parameters.jsCode).toContain("$workflow.name==='getdone-staging-deployment_health'");
    expect(() => new Function(receipt.parameters.jsCode)).not.toThrow();
    // Other execution nodes, credentials, and connections match the reviewed templates.
    expect(staging.connections).toEqual(original.connections);
    expect(staging.nodes.filter((node: { id: string }) => !["guard", "trigger", "receipt"].includes(node.id)))
      .toEqual(original.nodes.filter((node: { id: string }) => !["guard", "trigger", "receipt"].includes(node.id)));
  });

  it("refuses to overwrite existing staging imports or production source templates", () => {
    const original = readFileSync(join(outputDir, "github_create_branch.json"), "utf8");
    expect(() => execFileSync(process.execPath, [exporter, outputDir], { stdio: "pipe" })).toThrow();
    expect(readFileSync(join(outputDir, "github_create_branch.json"), "utf8")).toBe(original);
    expect(() => execFileSync(process.execPath, [exporter, resolve("n8n")], { stdio: "pipe" })).toThrow();
  });
});
