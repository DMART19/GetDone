import fs from "node:fs";
import path from "node:path";

export interface ProductionAcceptanceSurfaceReport {
  generatedAt: string | null;
  lastLiveTestedAt: string | null;
  eligibleForProductionPromotion: boolean;
  connected: readonly {
    component: string;
    status: string;
    detail?: string;
    evidencePath?: string;
  }[];
  testedLive: readonly {
    area: string;
    status: string;
    lastTestedAt: string | null;
    evidencePath: string;
  }[];
  blocked: readonly {
    component: string;
    reason: string;
  }[];
  softwareDeploymentAcceptance: {
    status: string;
    provider: string;
    target: string;
    runId: string | null;
    sourceCommitSha: string | null;
    goodDeploymentReference: string | null;
    badDeploymentReference: string | null;
    rollbackFromDeploymentReference: string | null;
    rollbackToDeploymentReference: string | null;
    failedVerificationDetected: boolean;
    recoveryVerified: boolean;
    completedAt: string | null;
    lineageHash: string | null;
  } | null;
}

function fallback(): ProductionAcceptanceSurfaceReport {
  return {
    generatedAt: null,
    lastLiveTestedAt: null,
    eligibleForProductionPromotion: false,
    connected: [],
    testedLive: [],
    blocked: [{
      component: "Production acceptance report",
      reason:
        "No generated machine acceptance report is present in this runtime. Production promotion fails closed."
    }],
    softwareDeploymentAcceptance: null
  };
}

export function readProductionAcceptanceSurfaceReport(): ProductionAcceptanceSurfaceReport {
  const configured =
    process.env.GETDONE_PRODUCTION_ACCEPTANCE_REPORT_PATH?.trim();
  const file = configured
    ? path.resolve(configured)
    : path.join(
        process.cwd(),
        "release",
        "out",
        "production-acceptance-report.json"
      );

  try {
    const parsed = JSON.parse(
      fs.readFileSync(file, "utf8")
    ) as Partial<ProductionAcceptanceSurfaceReport>;

    if (
      typeof parsed.eligibleForProductionPromotion !== "boolean"
      || !Array.isArray(parsed.connected)
      || !Array.isArray(parsed.testedLive)
      || !Array.isArray(parsed.blocked)
    ) {
      return fallback();
    }

    return {
      generatedAt:
        typeof parsed.generatedAt === "string" ? parsed.generatedAt : null,
      lastLiveTestedAt:
        typeof parsed.lastLiveTestedAt === "string"
          ? parsed.lastLiveTestedAt
          : null,
      eligibleForProductionPromotion:
        parsed.eligibleForProductionPromotion,
      connected: parsed.connected,
      testedLive: parsed.testedLive,
      blocked: parsed.blocked,
      softwareDeploymentAcceptance:
        parsed.softwareDeploymentAcceptance ?? null
    };
  } catch {
    return fallback();
  }
}
