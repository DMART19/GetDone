import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("zero-downtime migration and production promotion contracts", () => {
  it("declares expand, migrate, and contract rules with a real previous release", () => {
    const policy = JSON.parse(
      fs.readFileSync(path.join(root,"config/zero-downtime-migration-policy.json"),"utf8")
    );
    expect(policy.schemaVersion).toBe("1.0.0");
    expect(policy.previousReleaseRef).toMatch(/^[a-f0-9]{40}$/);
    expect(policy.compatibilityWindowReleases).toBeGreaterThanOrEqual(1);
    expect(policy.phases.expand.forbidden).toContain("drop-column");
    expect(policy.phases.migrate.requirements).toContain("idempotent");
    expect(policy.phases.contract.requirements).toEqual(expect.arrayContaining([
      "old-fleet-drained",
      "transition-verification-passed",
      "fresh-verified-backup",
      "separate-release-from-expand"
    ]));
    expect(policy.migrations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        version:"2026-09-25.3",
        phase:"expand",
        transitionSchema:true,
        destructive:false,
        authorityCompatibilityRequired:true
      })
    ]));
  });

  it("passes the static zero-downtime migration verifier", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/verify-zero-downtime-migrations.mjs"],
      {cwd:root,encoding:"utf8"}
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok:true,
      verifier:"zero-downtime-migrations"
    });
  });

  it("defines one fail-closed workflow containing every production promotion gate", () => {
    const workflow = fs.readFileSync(
      path.join(root,".github/workflows/production-release-gate.yml"),
      "utf8"
    );
    for (const required of [
      "Collect exact-SHA CI evidence",
      "Run authoritative staging E2E",
      "Run live OpenRouter canary",
      "Run live safe integration canary",
      "Run worker readiness canary",
      "Run fail-closed production promotion gate",
      "production-promotion",
      "GETDONE_RELEASE_GATE_DATABASE_URL"
    ]) {
      expect(workflow).toContain(required);
    }

    const gate = fs.readFileSync(
      path.join(root,"scripts/verify-production-promotion.mjs"),
      "utf8"
    );
    for (const required of [
      "verify-dependencies.mjs",
      "verify-contract-versions.mjs",
      "verify-zero-downtime-migrations.mjs",
      "verify-release-artifacts.mjs",
      "verify-postgres-production.mjs",
      "backupFresh",
      "liveOpenRouterCanary",
      "liveSafeIntegrationCanary",
      "workerHealth"
    ]) {
      expect(gate).toContain(required);
    }
  });
});
