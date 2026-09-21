import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  assertProductionPromotionReceipt,
  createInitialSoftwarePipelineRecord,
  createSoftwareChangeEvidence,
  createSoftwareDeploymentEvidence,
  createSoftwarePostDeploymentVerificationEvidence,
  createSoftwareWorkerPlan,
  transitionSoftwarePipeline,
  type ProductionPromotionReceipt,
  type SoftwareChangeEvidence,
  type SoftwarePipelineRecord
} from "@/lib/execution/software-worker";

const plan = createSoftwareWorkerPlan({
  id: "software-plan",
  scope: {
    userId: "owner",
    portfolioId: "portfolio",
    companyId: "company",
    environment: "production"
  },
  repository: "DMART19/GetDone",
  baseRef: "main",
  isolatedBranch: "getdone/work-1",
  createdAt: "2026-09-20T22:00:00Z"
});

function changeEvidence(): SoftwareChangeEvidence {
  return createSoftwareChangeEvidence({
    planId: plan.id,
    planHash: plan.planHash,
    repository: plan.repository,
    isolatedBranch: plan.isolatedBranch,
    commitSha: "abc1234",
    diffHash: "diff",
    staticAnalysisEvidenceIds: ["static"],
    testEvidenceIds: ["test"],
    securityEvidenceIds: ["security"],
    stagingVerificationReceiptId: "verify-staging-1"
  });
}

function promotion(evidence: SoftwareChangeEvidence): ProductionPromotionReceipt {
  const base = {
    planId: plan.id,
    planHash: plan.planHash,
    evidenceHash: evidence.evidenceHash,
    scope: plan.scope,
    approvalId: "approval-1",
    approvalHash: "approval-hash",
    stagingVerificationReceiptId: "verify-staging-1",
    policyVersion: "policy-v1",
    issuedAt: "2026-09-20T22:10:00Z",
    expiresAt: "2026-09-20T22:20:00Z"
  };
  return { ...base, receiptHash: sha256Hex(base) };
}

function toAwaitingApproval(evidence: SoftwareChangeEvidence): SoftwarePipelineRecord {
  let record = createInitialSoftwarePipelineRecord(plan);
  const path = [
    "branch-created",
    "modified",
    "static-analysis",
    "tested",
    "security-checked",
    "preview",
    "staging"
  ] as const;
  for (const state of path) {
    record = transitionSoftwarePipeline({
      current: record,
      to: state,
      updatedAt: "2026-09-20T22:05:00Z",
      plan
    });
  }
  record = transitionSoftwarePipeline({
    current: record,
    to: "staging-verified",
    updatedAt: "2026-09-20T22:06:00Z",
    plan,
    evidence
  });
  return transitionSoftwarePipeline({
    current: record,
    to: "awaiting-production-approval",
    updatedAt: "2026-09-20T22:07:00Z",
    plan
  });
}

describe("Phase 21 software worker/deployment contracts", () => {
  it("locks coding cognition to the AI Gateway CODING role without giving it deployment authority", () => {
    expect(plan.codingRole).toBe("CODING");
    expect(plan.productionApprovalRequired).toBe(true);
    expect(plan.rollbackRequired).toBe(true);
  });

  it("requires static analysis tests security and exact plan/repository/branch lineage", () => {
    expect(() => createSoftwareChangeEvidence({
      planId: plan.id,
      planHash: plan.planHash,
      repository: plan.repository,
      isolatedBranch: plan.isolatedBranch,
      commitSha: "abc1234",
      diffHash: "diff",
      staticAnalysisEvidenceIds: [],
      testEvidenceIds: ["test"],
      securityEvidenceIds: ["security"]
    })).toThrow();
  });

  it("blocks production authorization without an explicit promotion receipt", () => {
    const evidence = changeEvidence();
    const record = toAwaitingApproval(evidence);
    expect(() => transitionSoftwarePipeline({
      current: record,
      to: "production-authorized",
      updatedAt: "2026-09-20T22:12:00Z",
      plan
    })).toThrow(/promotion/i);
  });

  it("binds production promotion to the exact plan hash and staged evidence hash", () => {
    const evidence = changeEvidence();
    const receipt = promotion(evidence);
    expect(assertProductionPromotionReceipt(
      receipt,
      plan,
      Date.parse("2026-09-20T22:12:00Z"),
      evidence.evidenceHash
    )).toBe(receipt);

    expect(() => assertProductionPromotionReceipt(
      { ...receipt, evidenceHash: "other-evidence" },
      plan,
      Date.parse("2026-09-20T22:12:00Z"),
      evidence.evidenceHash
    )).toThrow();
  });

  it("requires hash-bound deployment evidence before recording production deployment", () => {
    const evidence = changeEvidence();
    const receipt = promotion(evidence);
    let record = toAwaitingApproval(evidence);
    record = transitionSoftwarePipeline({
      current: record,
      to: "production-authorized",
      updatedAt: "2026-09-20T22:12:00Z",
      plan,
      promotion: receipt
    });

    expect(() => transitionSoftwarePipeline({
      current: record,
      to: "production-deployed",
      updatedAt: "2026-09-20T22:13:00Z",
      plan
    })).toThrow(/deployment evidence/i);

    const deployment = createSoftwareDeploymentEvidence({
      planId: plan.id,
      planHash: plan.planHash,
      evidenceHash: evidence.evidenceHash,
      promotionReceiptHash: receipt.receiptHash,
      executorId: "deployment-executor",
      executorVersion: "1.0.0",
      accepted: true,
      deploymentReference: "deploy-123",
      observedAt: "2026-09-20T22:13:00Z"
    });
    record = transitionSoftwarePipeline({
      current: record,
      to: "production-deployed",
      updatedAt: "2026-09-20T22:13:00Z",
      plan,
      deploymentEvidence: deployment
    });
    expect(record.deploymentEvidenceHash).toBe(deployment.deploymentEvidenceHash);
    expect(record.deploymentReference).toBe("deploy-123");
  });

  it("keeps deployment-provider acceptance separate from final success verification", () => {
    const evidence = changeEvidence();
    const receipt = promotion(evidence);
    let record = toAwaitingApproval(evidence);
    record = transitionSoftwarePipeline({
      current: record,
      to: "production-authorized",
      updatedAt: "2026-09-20T22:12:00Z",
      plan,
      promotion: receipt
    });
    const deployment = createSoftwareDeploymentEvidence({
      planId: plan.id,
      planHash: plan.planHash,
      evidenceHash: evidence.evidenceHash,
      promotionReceiptHash: receipt.receiptHash,
      executorId: "deployment-executor",
      executorVersion: "1.0.0",
      accepted: true,
      deploymentReference: "deploy-123",
      observedAt: "2026-09-20T22:13:00Z"
    });
    record = transitionSoftwarePipeline({
      current: record,
      to: "production-deployed",
      updatedAt: "2026-09-20T22:13:00Z",
      plan,
      deploymentEvidence: deployment
    });
    record = transitionSoftwarePipeline({
      current: record,
      to: "post-deploy-verifying",
      updatedAt: "2026-09-20T22:14:00Z",
      plan
    });

    expect(() => transitionSoftwarePipeline({
      current: record,
      to: "succeeded",
      updatedAt: "2026-09-20T22:15:00Z",
      plan
    })).toThrow(/independent post-deployment verification/i);

    const verification = createSoftwarePostDeploymentVerificationEvidence({
      planId: plan.id,
      deploymentEvidenceHash: deployment.deploymentEvidenceHash,
      verificationReceiptId: "verification-receipt-1",
      verified: true,
      observedAt: "2026-09-20T22:15:00Z"
    });
    const succeeded = transitionSoftwarePipeline({
      current: record,
      to: "succeeded",
      updatedAt: "2026-09-20T22:15:00Z",
      plan,
      postDeploymentVerification: verification
    });
    expect(succeeded.state).toBe("succeeded");
    expect(succeeded.postDeploymentVerificationHash).toBe(verification.evidenceHash);
  });
});
