import { describe, expect, it } from "vitest";
import {
  assertSoftwareDeploymentAcceptanceRun,
  createDeploymentProviderAcceptanceEvidence,
  createIndependentDeploymentVerificationEvidence,
  createSoftwareDeploymentAcceptanceRun,
  createStagingRollbackAcceptanceEvidence
} from "@/lib/execution/software-deployment-acceptance";

const commit = "abc123def456";

function provider(reference: string, at: string) {
  return createDeploymentProviderAcceptanceEvidence({
    deploymentReference: reference,
    deploymentUrl: reference,
    sourceCommitSha: commit,
    acceptedAt: at
  });
}

function verification(
  kind: "health" | "business",
  ok: boolean,
  at: string,
  suffix: string
) {
  return createIndependentDeploymentVerificationEvidence({
    kind,
    url: `https://staging.example.com/${kind === "health" ? "api/health" : ""}`,
    status: ok ? 200 : 503,
    ok,
    observedAt: at,
    responseHash: `response-${suffix}`
  });
}

function passedRun() {
  const good = provider("https://good.vercel.app", "2026-09-26T16:10:00Z");
  const bad = provider("https://bad.vercel.app", "2026-09-26T16:12:00Z");
  return createSoftwareDeploymentAcceptanceRun({
    runId: "acceptance-1",
    repository: "DMART19/GetDone",
    sourceCommitSha: commit,
    startedAt: "2026-09-26T16:09:00Z",
    completedAt: "2026-09-26T16:16:00Z",
    goodDeployment: good,
    goodVerification: [
      verification("health", true, "2026-09-26T16:10:20Z", "good-health"),
      verification("business", true, "2026-09-26T16:10:21Z", "good-business")
    ],
    badDeployment: bad,
    badVerification: [
      verification("health", false, "2026-09-26T16:12:20Z", "bad-health"),
      verification("business", true, "2026-09-26T16:12:21Z", "bad-business")
    ],
    rollback: createStagingRollbackAcceptanceEvidence({
      alias: "staging.example.com",
      fromDeploymentReference: bad.deploymentReference,
      toDeploymentReference: good.deploymentReference,
      acceptedAt: "2026-09-26T16:13:00Z"
    }),
    recoveryVerification: [
      verification("health", true, "2026-09-26T16:14:20Z", "recovery-health"),
      verification("business", true, "2026-09-26T16:14:21Z", "recovery-business")
    ],
    status: "passed"
  });
}

describe("software deployment acceptance", () => {
  it("keeps provider READY non-authoritative until independent verification and recovery pass", () => {
    const run = passedRun();
    expect(run.goodDeployment.providerState).toBe("READY");
    expect(run.goodDeployment.authoritativeSuccess).toBe(false);
    expect(run.rollback.authoritativeRecovery).toBe(false);
    expect(run.status).toBe("passed");
    expect(assertSoftwareDeploymentAcceptanceRun(run).lineageHash).toBe(run.lineageHash);
  });

  it("refuses to call acceptance passed when the controlled bad deployment was not detected", () => {
    const good = provider("https://good.vercel.app", "2026-09-26T16:10:00Z");
    const bad = provider("https://bad.vercel.app", "2026-09-26T16:12:00Z");

    expect(() => createSoftwareDeploymentAcceptanceRun({
      runId: "acceptance-2",
      repository: "DMART19/GetDone",
      sourceCommitSha: commit,
      startedAt: "2026-09-26T16:09:00Z",
      completedAt: "2026-09-26T16:16:00Z",
      goodDeployment: good,
      goodVerification: [
        verification("health", true, "2026-09-26T16:10:20Z", "good-health"),
        verification("business", true, "2026-09-26T16:10:21Z", "good-business")
      ],
      badDeployment: bad,
      badVerification: [
        verification("health", true, "2026-09-26T16:12:20Z", "bad-health")
      ],
      rollback: createStagingRollbackAcceptanceEvidence({
        alias: "staging.example.com",
        fromDeploymentReference: bad.deploymentReference,
        toDeploymentReference: good.deploymentReference,
        acceptedAt: "2026-09-26T16:13:00Z"
      }),
      recoveryVerification: [
        verification("health", true, "2026-09-26T16:14:20Z", "recovery-health"),
        verification("business", true, "2026-09-26T16:14:21Z", "recovery-business")
      ],
      status: "passed"
    })).toThrow(/detected bad deployment/i);
  });

  it("rejects tampered lineage", () => {
    const run = passedRun();
    expect(() => assertSoftwareDeploymentAcceptanceRun({
      ...run,
      sourceCommitSha: "tampered"
    })).toThrow(/integrity/i);
  });
});
