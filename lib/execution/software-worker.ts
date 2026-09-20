import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { AIRole } from "@/lib/ai-gateway/contracts";

export const SOFTWARE_WORKER_CONTRACT_VERSION = "1.0.0";

export type SoftwarePipelineState =
  | "inspect"
  | "branch-created"
  | "modified"
  | "static-analysis"
  | "tested"
  | "security-checked"
  | "preview"
  | "staging"
  | "staging-verified"
  | "awaiting-production-approval"
  | "production-authorized"
  | "production-deployed"
  | "post-deploy-verifying"
  | "succeeded"
  | "failed"
  | "rolled-back";

export interface SoftwareWorkerPlan {
  id: string;
  scope: TrustedExecutionScope;
  repository: string;
  baseRef: string;
  isolatedBranch: string;
  codingRole: Extract<AIRole, "CODING">;
  productionApprovalRequired: true;
  rollbackRequired: true;
  createdAt: string;
  planHash: string;
}

export interface SoftwareChangeEvidence {
  planId: string;
  commitSha: string;
  diffHash: string;
  staticAnalysisEvidenceIds: readonly string[];
  testEvidenceIds: readonly string[];
  securityEvidenceIds: readonly string[];
  previewReference?: string;
  stagingDeploymentId?: string;
  stagingVerificationReceiptId?: string;
  evidenceHash: string;
}

export interface ProductionPromotionReceipt {
  planId: string;
  scope: TrustedExecutionScope;
  approvalId: string;
  approvalHash: string;
  stagingVerificationReceiptId: string;
  policyVersion: string;
  issuedAt: string;
  expiresAt: string;
  receiptHash: string;
}

export interface SoftwarePipelineRecord {
  planId: string;
  state: SoftwarePipelineState;
  updatedAt: string;
  evidenceHash?: string;
  productionPromotionReceiptHash?: string;
  deploymentReference?: string;
  recordHash: string;
}

export interface SoftwareDeploymentExecutor {
  readonly id: string;
  readonly version: string;
  deploy(input: {
    plan: SoftwareWorkerPlan;
    evidence: SoftwareChangeEvidence;
    promotion: ProductionPromotionReceipt;
  }): Promise<{
    accepted: boolean;
    deploymentReference?: string;
    observedAt: string;
    authoritativeSuccess: false;
  }>;
}

const allowed: Record<SoftwarePipelineState, readonly SoftwarePipelineState[]> = {
  inspect: ["branch-created", "failed"],
  "branch-created": ["modified", "failed"],
  modified: ["static-analysis", "failed"],
  "static-analysis": ["tested", "failed"],
  tested: ["security-checked", "failed"],
  "security-checked": ["preview", "failed"],
  preview: ["staging", "failed"],
  staging: ["staging-verified", "failed"],
  "staging-verified": ["awaiting-production-approval", "failed"],
  "awaiting-production-approval": ["production-authorized", "failed"],
  "production-authorized": ["production-deployed", "failed"],
  "production-deployed": ["post-deploy-verifying", "rolled-back", "failed"],
  "post-deploy-verifying": ["succeeded", "rolled-back", "failed"],
  succeeded: [],
  failed: [],
  "rolled-back": []
};

export function createSoftwareWorkerPlan(
  input: Omit<SoftwareWorkerPlan, "codingRole" | "productionApprovalRequired" | "rollbackRequired" | "planHash">
): SoftwareWorkerPlan {
  if (!input.repository.includes("/") || !input.baseRef || !input.isolatedBranch) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Repository/base/isolated branch are required");
  }
  const base = {
    ...input,
    codingRole: "CODING" as const,
    productionApprovalRequired: true as const,
    rollbackRequired: true as const
  };
  return Object.freeze({ ...base, planHash: sha256Hex(base) });
}

export function createSoftwareChangeEvidence(
  input: Omit<SoftwareChangeEvidence, "evidenceHash">
): SoftwareChangeEvidence {
  if (
    !input.commitSha
    || !input.diffHash
    || input.staticAnalysisEvidenceIds.length === 0
    || input.testEvidenceIds.length === 0
    || input.securityEvidenceIds.length === 0
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Software change evidence requires commit, diff, static analysis, tests, and security evidence"
    );
  }
  return Object.freeze({ ...input, evidenceHash: sha256Hex(input) });
}

export function assertProductionPromotionReceipt(
  receipt: ProductionPromotionReceipt,
  plan: SoftwareWorkerPlan,
  now = Date.now()
) {
  const { receiptHash, ...base } = receipt;
  if (
    sha256Hex(base) !== receiptHash
    || receipt.planId !== plan.id
    || receipt.scope.portfolioId !== plan.scope.portfolioId
    || receipt.scope.companyId !== plan.scope.companyId
    || receipt.scope.environment !== "production"
    || Date.parse(receipt.issuedAt) > now
    || Date.parse(receipt.expiresAt) <= now
    || !receipt.approvalHash
    || !receipt.stagingVerificationReceiptId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Production promotion receipt is stale, invalid, or outside plan authority"
    );
  }
  return receipt;
}

export function transitionSoftwarePipeline(input: {
  current: SoftwarePipelineRecord;
  to: SoftwarePipelineState;
  updatedAt: string;
  evidence?: SoftwareChangeEvidence;
  promotion?: ProductionPromotionReceipt;
  plan: SoftwareWorkerPlan;
  deploymentReference?: string;
}): SoftwarePipelineRecord {
  const { recordHash, ...currentBase } = input.current;
  if (sha256Hex(currentBase) !== recordHash) {
    throw new ControlPlaneError("FORBIDDEN", "Software pipeline record integrity check failed");
  }
  if (!allowed[input.current.state].includes(input.to)) {
    throw new ControlPlaneError("CONFLICT", `Invalid software pipeline transition ${input.current.state} -> ${input.to}`);
  }
  if (input.to === "staging-verified" && !input.evidence?.stagingVerificationReceiptId) {
    throw new ControlPlaneError("FORBIDDEN", "Staging verification evidence is required");
  }
  if (input.to === "production-authorized") {
    if (!input.promotion) {
      throw new ControlPlaneError("FORBIDDEN", "Production promotion requires approval receipt");
    }
    assertProductionPromotionReceipt(input.promotion, input.plan, Date.parse(input.updatedAt));
  }
  if (input.to === "production-deployed" && !input.current.productionPromotionReceiptHash) {
    throw new ControlPlaneError("FORBIDDEN", "Production deployment requires prior production authorization");
  }

  const base = {
    planId: input.current.planId,
    state: input.to,
    updatedAt: input.updatedAt,
    evidenceHash: input.evidence?.evidenceHash ?? input.current.evidenceHash,
    productionPromotionReceiptHash:
      input.promotion?.receiptHash ?? input.current.productionPromotionReceiptHash,
    deploymentReference: input.deploymentReference ?? input.current.deploymentReference
  };
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}

export function createInitialSoftwarePipelineRecord(plan: SoftwareWorkerPlan): SoftwarePipelineRecord {
  const base = {
    planId: plan.id,
    state: "inspect" as const,
    updatedAt: plan.createdAt,
    evidenceHash: undefined,
    productionPromotionReceiptHash: undefined,
    deploymentReference: undefined
  };
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}
