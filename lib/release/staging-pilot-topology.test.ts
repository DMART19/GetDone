import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Worker = {
  name: string; serviceType: string; plan: string; action: string;
  build: string; start: string; role: string; healthPort: number; workerId: string;
};
const plan = JSON.parse(readFileSync("config/staging-pilot-topology.json","utf8"));
const workers: Worker[] = [plan.deployment.job,plan.deployment.orchestration];

describe("owner pilot staging deployment isolation", () => {
  it("requires approved staging-only project and preserves production resources", () => {
    expect(plan.status).toBe("NOT_DEPLOYED");
    expect(plan.ownerOnly).toBe(true);
    expect(plan.stagingSupabaseProject).toBe("ddxjiszbsmmbqxuoecmg");
    expect(plan.productionIsolation.doNotApplyRootRenderYaml).toBe(true);
    expect(plan.productionIsolation.neverReuseProductionSecrets).toBe(true);
    expect(plan.deployment.web.name).toBe("getdone-web-staging");
    expect(plan.deployment.web.renderServiceId).toBe("srv-db76v2l9fdbs73f8lngg");
    for (const service of [plan.deployment.web,...workers]) {
      expect(service.name).not.toBe(plan.productionIsolation.productionWeb);
      expect(plan.productionIsolation.productionWorkers).not.toContain(service.name);
      expect(service.role).toMatch(/^(web|job-worker|orchestration-worker)$/);
      expect(service.action).not.toContain("production");
    }
    expect(plan.deployment.pinExactReviewedSha).toBe(true);
    expect(plan.requiredMigration).toBe("2026-10-17.2");
  });

  it("does not silently create billable worker services", () => {
    expect(plan.approval.autoDeploy).toBe(false);
    expect(plan.approval.workerMonthlyMaxUsd).toBe(14);
    expect(workers).toHaveLength(2);
    expect(workers.reduce((sum) => sum + plan.approval.workerUnitUsd,0)).toBeLessThanOrEqual(plan.approval.workerMonthlyMaxUsd);
    expect(plan.approval.createOnlyAfter).toEqual(expect.arrayContaining([
      "real_pre_migration_backup_restored",
      "staging_only_db_and_verified_tls",
      "auth_and_worker_migrations_reviewed_and_applied",
      "worker_rls_preflight_passed"
    ]));
    expect(workers.map(w => w.name)).toEqual([
      "getdone-job-worker-staging","getdone-orchestration-worker-staging"
    ]);
    expect(workers.map(w => w.serviceType)).toEqual(["background-worker","background-worker"]);
    expect(workers.map(w => w.plan)).toEqual(["starter","starter"]);
    expect(workers.every(w => w.action === "create-after-gates-only")).toBe(true);
    expect(workers.map(w => w.workerId)).toEqual([
      "getdone-job-worker-staging-1","getdone-orchestration-worker-staging-1"
    ]);
    expect(workers.map(w => w.healthPort)).toEqual([3001,3002]);
    expect(workers.every(w => w.healthPath === "/readyz")).toBe(true);
  });

  it("pins the correct scripts for the three service roles", () => {
    expect(plan.deployment.web.build).toBe("npm ci --include=dev && npm run build");
    expect(plan.deployment.web.start).toBe("npm run start");
    expect(plan.deployment.job.build).toBe("npm ci --include=dev && npm run build:worker");
    expect(plan.deployment.job.start).toBe("npm run start:worker");
    expect(plan.deployment.orchestration.build).toBe("npm ci --include=dev && npm run build:orchestration-worker");
    expect(plan.deployment.orchestration.start).toBe("npm run start:orchestration-worker");
  });

  it("requires verified TLS, scoped runtime, owner authentication and separate n8n", () => {
    expect(plan.environment.checkedNonsecret).toMatchObject({
      GETDONE_RUNTIME_ENV:"staging", GETDONE_DB_SSL:"true",
      GETDONE_DATA_MODE:"authoritative",
      GETDONE_DB_RUNTIME_ROLE:"getdone_tenant_runtime",
      GETDONE_N8N_ENABLED:"false"
    });
    expect(plan.environment.requiredSecrets).toContain("DATABASE_URL");
    expect(plan.environment.requiredSameForEach).toContain("PGSSLROOTCERT");
    expect(plan.environment.checkedNonsecret.GETDONE_WEBAUTHN_ORIGINS).toBe(plan.publicOrigin);
    expect(plan.environment.optionalAdaptersOff).toEqual(["Composio","Langfuse"]);
    expect(plan.acceptanceEvidenceRequired).toContain("real_external_side_effect_independently_verified");
    expect(plan.acceptanceEvidenceRequired).toContain("fresh_post_migration_backup_restore");
    // No credentials or URLs are included in the static manifest.
    const raw = JSON.stringify(plan);
    expect(raw).not.toContain("-----BEGIN PRIVATE KEY-----");
    expect(raw).not.toContain("getdone-production-runtime");
    expect(raw).not.toContain("getdone-web.onrender.com");
    expect(raw).not.toMatch(/postgres(?:ql)?:\/\//i);
  });
});
