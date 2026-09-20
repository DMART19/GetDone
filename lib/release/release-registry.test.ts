import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_POLICY_VERSION } from "@/lib/domain/policy-registry";
import { POLICY_ENGINE_VERSION } from "@/lib/planning/policy-engine";

const root = process.cwd();
const readJson = (relativePath: string) =>
  JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")) as Record<string, any>;

const registry = readJson("release/version-registry.json");
const environment = readJson("release/environment-manifest.json");
const packageJson = readJson("package.json");

describe("Phase 41 release/version registry", () => {
  it("binds the application and policy versions to the current codebase", () => {
    expect(registry.appVersion).toBe(packageJson.version);
    expect(registry.policy.registryVersion).toBe(CURRENT_POLICY_VERSION);
    expect(registry.policy.engineVersion).toBe(POLICY_ENGINE_VERSION);
  });

  it("binds every declared schema and adapter version to an existing source file", () => {
    for (const entry of Object.values(registry.schemaVersions) as Array<Record<string, string>>) {
      expect(entry.version.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(root, entry.sourcePath))).toBe(true);
    }
    for (const entry of Object.values(registry.adapters) as Array<Record<string, string>>) {
      expect(entry.version.length).toBeGreaterThan(0);
      expect(entry.status.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(root, entry.sourcePath))).toBe(true);
    }
  });

  it("records the exact absence of database migrations instead of inventing schema state", () => {
    expect(registry.database.status).toBe("not-connected");
    expect(registry.database.migrationVersion).toBe("UNIMPLEMENTED");
    expect(registry.database.schemaVersion).toBe("UNIMPLEMENTED");
  });

  it("records the exact absence of a live AI Gateway instead of inventing a route version", () => {
    expect(registry.aiGateway.status).toBe("not-connected");
    expect(registry.aiGateway.adapterVersion).toBe("UNIMPLEMENTED");
    expect(registry.aiGateway.routingPolicyVersion).toBe("UNCONFIGURED");
  });

  it("defines development staging and production without overstating readiness", () => {
    expect(Object.keys(environment.environments).sort())
      .toEqual(["development", "production", "staging"]);
    expect(environment.environments.production.productionReady).toBe(false);
    expect(environment.environments.production.deployment.status).toBe("not-connected");
    expect(environment.environments.production.deployment.deploymentId).toBeNull();
    expect(
      Object.values(environment.environments.production.connections)
        .some((connected) => connected === false)
    ).toBe(true);
  });

  it("tracks evidence/manual inputs and generated outputs explicitly", () => {
    for (const sourcePath of [
      ...registry.acceptanceEvidencePaths,
      ...registry.manualSourcePaths
    ]) {
      expect(fs.existsSync(path.join(root, sourcePath))).toBe(true);
    }
    expect(registry.generatedArtifacts.machineManifest)
      .toBe("release/out/release-manifest.json");
    expect(registry.generatedArtifacts.operatingManual)
      .toBe("release/out/OPERATING_MANUAL.md");
  });

  it("keeps static release declarations free of raw secret-shaped values", () => {
    const content = [
      JSON.stringify(registry),
      JSON.stringify(environment)
    ].join("\n");

    expect(content).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(content).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}\b/);
    expect(content).not.toMatch(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/);
  });
});
