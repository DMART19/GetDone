import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  assertProductionPromotionReceipt,
  createInitialSoftwarePipelineRecord,
  createSoftwareChangeEvidence,
  createSoftwareWorkerPlan,
  transitionSoftwarePipeline,
  type ProductionPromotionReceipt
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

function promotion(): ProductionPromotionReceipt {
  const base = {
    planId: plan.id,
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

describe("Phase 21 software worker/deployment contracts", () => {
  it("locks coding cognition to the AI Gateway CODING role without giving it deployment authority", () => {
    expect(plan.codingRole).toBe("CODING");
    expect(plan.productionApprovalRequired).toBe(true);
    expect(plan.rollbackRequired).toBe(true);
  });

  it("requires static analysis tests and security evidence", () => {
    expect(() => createSoftwareChangeEvidence({
      planId: plan.id,
      commitSha: "abc1234",
      diffHash: "diff",
      staticAnalysisEvidenceIds: [],
      testEvidenceIds: ["test"],
      securityEvidenceIds: ["security"]
    })).toThrow();
  });

  it("blocks production authorization without an explicit promotion receipt", () => {
    let record = createInitialSoftwarePipelineRecord(plan);
    const path = [
      "branch-created","modified","static-analysis","tested","security-checked",
      "preview","staging"
    ] as const;
    for (const state of path) {
      record = transitionSoftwarePipeline({ current: record, to: state, updatedAt: "2026-09-20T22:05:00Z", plan });
    }
    const evidence = createSoftwareChangeEvidence({
      planId: plan.id,
      commitSha: "abc1234",
      diffHash: "diff",
      staticAnalysisEvidenceIds: ["static"],
      testEvidenceIds: ["test"],
      securityEvidenceIds: ["security"],
      stagingVerificationReceiptId: "verify-staging-1"
    });
    record = transitionSoftwarePipeline({
      current: record,
      to: "staging-verified",
      updatedAt: "2026-09-20T22:06:00Z",
      plan,
      evidence
    });
    record = transitionSoftwarePipeline({
      current: record,
      to: "awaiting-production-approval",
      updatedAt: "2026-09-20T22:07:00Z",
      plan
    });
    expect(() => transitionSoftwarePipeline({
      current: record,
      to: "production-authorized",
      updatedAt: "2026-09-20T22:12:00Z",
      plan
    })).toThrow(/promotion/i);
  });

  it("accepts a fresh scoped production promotion receipt and keeps deployment success separate", () => {
    const receipt = promotion();
    expect(assertProductionPromotionReceipt(
      receipt,
      plan,
      Date.parse("2026-09-20T22:12:00Z")
    )).toBe(receipt);
  });
});
