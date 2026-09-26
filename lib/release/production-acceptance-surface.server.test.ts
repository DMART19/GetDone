import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  readProductionAcceptanceSurfaceReport
} from "@/lib/release/production-acceptance-surface.server";

const fixtureDir = path.join(
  process.cwd(),
  "test-results",
  "production-acceptance-surface-fixture"
);
const fixturePath = path.join(fixtureDir, "report.json");

afterEach(() => {
  delete process.env.GETDONE_PRODUCTION_ACCEPTANCE_REPORT_PATH;
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("production acceptance owner surface report", () => {
  it("fails closed when no machine report is present", () => {
    process.env.GETDONE_PRODUCTION_ACCEPTANCE_REPORT_PATH =
      path.join(fixtureDir, "missing.json");

    const report = readProductionAcceptanceSurfaceReport();

    expect(report.eligibleForProductionPromotion).toBe(false);
    expect(report.blocked).toEqual([
      expect.objectContaining({
        component: "Production acceptance report"
      })
    ]);
  });

  it("surfaces persisted live deployment lineage without inventing eligibility", () => {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      fixturePath,
      JSON.stringify({
        generatedAt: "2026-09-26T16:30:00Z",
        lastLiveTestedAt: "2026-09-26T16:29:00Z",
        eligibleForProductionPromotion: false,
        connected: [{
          component: "Software deployment staging target",
          status: "live-accepted"
        }],
        testedLive: [{
          area: "software-deployment-acceptance",
          status: "passed",
          lastTestedAt: "2026-09-26T16:29:00Z",
          evidencePath: "test-results/software-deployment-acceptance.json"
        }],
        blocked: [{
          component: "Production software deployment",
          reason: "Release registry status is not-connected."
        }],
        softwareDeploymentAcceptance: {
          status: "passed",
          provider: "vercel",
          target: "staging",
          runId: "run-1",
          sourceCommitSha: "abc123",
          goodDeploymentReference: "https://good.vercel.app",
          badDeploymentReference: "https://bad.vercel.app",
          rollbackFromDeploymentReference: "https://bad.vercel.app",
          rollbackToDeploymentReference: "https://good.vercel.app",
          failedVerificationDetected: true,
          recoveryVerified: true,
          completedAt: "2026-09-26T16:29:00Z",
          lineageHash: "lineage"
        }
      }),
      "utf8"
    );
    process.env.GETDONE_PRODUCTION_ACCEPTANCE_REPORT_PATH = fixturePath;

    const report = readProductionAcceptanceSurfaceReport();

    expect(report.eligibleForProductionPromotion).toBe(false);
    expect(report.softwareDeploymentAcceptance).toMatchObject({
      failedVerificationDetected: true,
      recoveryVerified: true,
      lineageHash: "lineage"
    });
  });
});
