import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  createSoftwareDeploymentEvidence,
  createSoftwarePostDeploymentVerificationEvidence,
  createSoftwareWorkerPlan,
  type ProductionPromotionReceipt,
  type SoftwareDeploymentExecutor
} from "@/lib/execution/software-worker";
import {
  SoftwareWorkerRuntime,
  type SoftwareWorkerRuntimeRecord,
  type SoftwareWorkerRuntimeStore,
  type SoftwareWorkerTooling
} from "@/lib/execution/software-worker-runtime";

const plan = createSoftwareWorkerPlan({
  id: "software-runtime-plan",
  scope: {
    userId: "owner",
    portfolioId: "portfolio",
    companyId: "company",
    environment: "production"
  },
  repository: "DMART19/GetDone",
  baseRef: "main",
  isolatedBranch: "getdone/software-runtime-plan",
  createdAt: "2026-09-21T04:00:00Z"
});

class MemoryRuntimeStore implements SoftwareWorkerRuntimeStore {
  value: SoftwareWorkerRuntimeRecord | null = null;

  async get(id: string) {
    return this.value?.planId === id ? this.value : null;
  }

  async save(record: SoftwareWorkerRuntimeRecord, expected?: string) {
    if (this.value && expected !== this.value.runtimeHash) throw new Error("runtime CAS conflict");
    this.value = record;
  }
}

function tooling(calls: string[]): SoftwareWorkerTooling {
  return {
    inspect: async () => { calls.push("inspect"); },
    createBranch: async () => { calls.push("branch"); },
    modify: async () => {
      calls.push("modify");
      return { commitSha: "abc1234", diffHash: "diff-hash" };
    },
    staticAnalysis: async () => {
      calls.push("static");
      return ["static-1"];
    },
    test: async () => {
      calls.push("test");
      return ["test-1"];
    },
    securityCheck: async () => {
      calls.push("security");
      return ["security-1"];
    },
    preview: async () => {
      calls.push("preview");
      return "preview-1";
    },
    stage: async () => {
      calls.push("stage");
      return "staging-1";
    },
    verifyStaging: async () => {
      calls.push("verify-staging");
      return "staging-receipt-1";
    },
    rollback: async () => { calls.push("rollback"); }
  };
}

function promotion(evidenceHash: string): ProductionPromotionReceipt {
  const base = {
    planId: plan.id,
    planHash: plan.planHash,
    evidenceHash,
    scope: plan.scope,
    approvalId: "approval-1",
    approvalHash: "approval-hash",
    stagingVerificationReceiptId: "staging-receipt-1",
    policyVersion: "policy-1",
    issuedAt: "2026-09-21T04:09:00Z",
    expiresAt: "2026-09-21T05:00:00Z"
  };
  return { ...base, receiptHash: sha256Hex(base) };
}

describe("SoftwareWorkerRuntime", () => {
  it("runs the preparation pipeline to an explicit production approval boundary", async () => {
    const calls: string[] = [];
    const store = new MemoryRuntimeStore();
    const deployments: SoftwareDeploymentExecutor = {
      id: "deployment-executor",
      version: "1.0.0",
      deploy: async () => { throw new Error("not used during prepare"); }
    };
    const runtime = new SoftwareWorkerRuntime(
      tooling(calls),
      deployments,
      store,
      () => new Date("2026-09-21T04:10:00Z")
    );

    const prepared = await runtime.prepare(plan);
    expect(prepared.pipeline.state).toBe("awaiting-production-approval");
    expect(prepared.artifacts.changeEvidence).toMatchObject({
      commitSha: "abc1234",
      stagingDeploymentId: "staging-1",
      stagingVerificationReceiptId: "staging-receipt-1"
    });
    expect(calls).toEqual([
      "inspect", "branch", "modify", "static", "test", "security",
      "preview", "stage", "verify-staging"
    ]);

    await runtime.prepare(plan);
    expect(calls).toHaveLength(9);
  });

  it("authorizes, deploys, verifies, and reaches success only from exact persisted lineage", async () => {
    const calls: string[] = [];
    const store = new MemoryRuntimeStore();
    const deployments: SoftwareDeploymentExecutor = {
      id: "deployment-executor",
      version: "1.0.0",
      deploy: async ({ plan: inputPlan, evidence, promotion: receipt }) =>
        createSoftwareDeploymentEvidence({
          planId: inputPlan.id,
          planHash: inputPlan.planHash,
          evidenceHash: evidence.evidenceHash,
          promotionReceiptHash: receipt.receiptHash,
          executorId: "deployment-executor",
          executorVersion: "1.0.0",
          accepted: true,
          deploymentReference: "production-deploy-1",
          observedAt: "2026-09-21T04:12:00Z"
        })
    };
    const runtime = new SoftwareWorkerRuntime(
      tooling(calls),
      deployments,
      store,
      () => new Date("2026-09-21T04:13:00Z")
    );

    const prepared = await runtime.prepare(plan);
    const evidenceHash = prepared.artifacts.changeEvidence!.evidenceHash;
    const receipt = promotion(evidenceHash);
    const authorized = await runtime.authorizeProduction(plan, receipt);
    expect(authorized.pipeline.state).toBe("production-authorized");

    await expect(runtime.deployProduction(plan, {
      ...receipt,
      receiptHash: "different-promotion"
    })).rejects.toThrow(/persisted authorization/i);

    const deployed = await runtime.deployProduction(plan, receipt);
    expect(deployed.runtime.pipeline.state).toBe("post-deploy-verifying");
    expect(deployed.runtime.pipeline.deploymentReference).toBe("production-deploy-1");

    const verification = createSoftwarePostDeploymentVerificationEvidence({
      planId: plan.id,
      deploymentEvidenceHash: deployed.deployment.deploymentEvidenceHash,
      verificationReceiptId: "post-deploy-receipt-1",
      verified: true,
      observedAt: "2026-09-21T04:14:00Z"
    });
    const succeeded = await runtime.completeProductionVerification(plan, verification);
    expect(succeeded.pipeline.state).toBe("succeeded");
  });

  it("supports governed rollback after production deployment", async () => {
    const calls: string[] = [];
    const store = new MemoryRuntimeStore();
    const deployments: SoftwareDeploymentExecutor = {
      id: "deployment-executor",
      version: "1.0.0",
      deploy: async ({ plan: inputPlan, evidence, promotion: receipt }) =>
        createSoftwareDeploymentEvidence({
          planId: inputPlan.id,
          planHash: inputPlan.planHash,
          evidenceHash: evidence.evidenceHash,
          promotionReceiptHash: receipt.receiptHash,
          executorId: "deployment-executor",
          executorVersion: "1.0.0",
          accepted: true,
          deploymentReference: "production-deploy-rollback",
          observedAt: "2026-09-21T04:12:00Z"
        })
    };
    const runtime = new SoftwareWorkerRuntime(
      tooling(calls),
      deployments,
      store,
      () => new Date("2026-09-21T04:13:00Z")
    );
    const prepared = await runtime.prepare(plan);
    const receipt = promotion(prepared.artifacts.changeEvidence!.evidenceHash);
    await runtime.authorizeProduction(plan, receipt);
    await runtime.deployProduction(plan, receipt);
    const rolledBack = await runtime.rollback(plan);
    expect(rolledBack.pipeline.state).toBe("rolled-back");
    expect(calls).toContain("rollback");
  });
});
