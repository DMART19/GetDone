import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { AIRole } from "@/lib/ai-gateway/contracts";

export const SOFTWARE_WORKER_CONTRACT_VERSION = "1.1.0";

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
  planHash: string;
  repository: string;
  isolatedBranch: string;
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
  planHash: string;
  evidenceHash: string;
  scope: TrustedExecutionScope;
  approvalId: string;
  approvalHash: string;
  stagingVerificationReceiptId: string;
  policyVersion: string;
  issuedAt: string;
  expiresAt: string;
  receiptHash: string;
}

export interface SoftwareDeploymentEvidence {
  source: "software-deployment-executor";
  planId: string;
  planHash: string;
  evidenceHash: string;
  promotionReceiptHash: string;
  executorId: string;
  executorVersion: string;
  environment: "production";
  accepted: boolean;
  deploymentReference?: string;
  observedAt: string;
  authoritativeSuccess: false;
  deploymentEvidenceHash: string;
}

export interface SoftwarePostDeploymentVerificationEvidence {
  source: "verification-service";
  planId: string;
  deploymentEvidenceHash: string;
  verificationReceiptId: string;
  verified: boolean;
  observedAt: string;
  evidenceHash: string;
}

export interface SoftwarePipelineRecord {
  planId: string;
  state: SoftwarePipelineState;
  updatedAt: string;
  evidenceHash?: string;
  productionPromotionReceiptHash?: string;
  deploymentEvidenceHash?: string;
  postDeploymentVerificationHash?: string;
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
  }): Promise<SoftwareDeploymentEvidence>;
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

function parseTimestamp(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

export function createSoftwareWorkerPlan(
  input: Omit<SoftwareWorkerPlan, "codingRole" | "productionApprovalRequired" | "rollbackRequired" | "planHash">
): SoftwareWorkerPlan {
  if (!input.repository.includes("/") || !input.baseRef || !input.isolatedBranch) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Repository/base/isolated branch are required");
  }
  const createdAt = new Date(parseTimestamp(input.createdAt, "software plan createdAt")).toISOString();
  const base = {
    ...input,
    createdAt,
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
    !input.planId
    || !input.planHash
    || !input.repository
    || !input.isolatedBranch
    || !input.commitSha
    || !input.diffHash
    || input.staticAnalysisEvidenceIds.length === 0
    || input.testEvidenceIds.length === 0
    || input.securityEvidenceIds.length === 0
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Software change evidence requires plan lineage, repository/branch, commit, diff, static analysis, tests, and security evidence"
    );
  }
  return Object.freeze({ ...input, evidenceHash: sha256Hex(input) });
}

export function assertSoftwareChangeEvidenceForPlan(
  evidence: SoftwareChangeEvidence,
  plan: SoftwareWorkerPlan
) {
  const { evidenceHash, ...base } = evidence;
  if (
    sha256Hex(base) !== evidenceHash
    || evidence.planId !== plan.id
    || evidence.planHash !== plan.planHash
    || evidence.repository !== plan.repository
    || evidence.isolatedBranch !== plan.isolatedBranch
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Software change evidence does not match the authorized plan/repository/branch lineage"
    );
  }
  return evidence;
}

export function assertProductionPromotionReceipt(
  receipt: ProductionPromotionReceipt,
  plan: SoftwareWorkerPlan,
  now = Date.now(),
  expectedEvidenceHash?: string
) {
  const { receiptHash, ...base } = receipt;
  if (
    sha256Hex(base) !== receiptHash
    || receipt.planId !== plan.id
    || receipt.planHash !== plan.planHash
    || receipt.scope.userId !== plan.scope.userId
    || receipt.scope.portfolioId !== plan.scope.portfolioId
    || receipt.scope.companyId !== plan.scope.companyId
    || receipt.scope.environment !== "production"
    || Date.parse(receipt.issuedAt) > now
    || Date.parse(receipt.expiresAt) <= now
    || !receipt.approvalHash
    || !receipt.stagingVerificationReceiptId
    || !receipt.evidenceHash
    || (expectedEvidenceHash !== undefined && receipt.evidenceHash !== expectedEvidenceHash)
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Production promotion receipt is stale, invalid, or outside exact plan/evidence authority"
    );
  }
  return receipt;
}

export function createSoftwareDeploymentEvidence(
  input: Omit<
    SoftwareDeploymentEvidence,
    "source" | "environment" | "authoritativeSuccess" | "deploymentEvidenceHash"
  >
): SoftwareDeploymentEvidence {
  if (input.accepted && !input.deploymentReference) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Accepted software deployment evidence requires a deployment reference"
    );
  }
  const observedAt = new Date(parseTimestamp(
    input.observedAt,
    "software deployment observedAt"
  )).toISOString();
  const base = {
    ...input,
    source: "software-deployment-executor" as const,
    environment: "production" as const,
    observedAt,
    authoritativeSuccess: false as const
  };
  return Object.freeze({
    ...base,
    deploymentEvidenceHash: sha256Hex(base)
  });
}

export function assertSoftwareDeploymentEvidence(input: {
  deployment: SoftwareDeploymentEvidence;
  plan: SoftwareWorkerPlan;
  expectedEvidenceHash: string;
  expectedPromotionReceiptHash: string;
}) {
  const { deploymentEvidenceHash, ...base } = input.deployment;
  if (
    sha256Hex(base) !== deploymentEvidenceHash
    || input.deployment.source !== "software-deployment-executor"
    || input.deployment.planId !== input.plan.id
    || input.deployment.planHash !== input.plan.planHash
    || input.deployment.evidenceHash !== input.expectedEvidenceHash
    || input.deployment.promotionReceiptHash !== input.expectedPromotionReceiptHash
    || input.deployment.environment !== "production"
    || input.deployment.authoritativeSuccess !== false
    || !input.deployment.accepted
    || !input.deployment.deploymentReference
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Software deployment evidence is invalid or outside exact plan/promotion lineage"
    );
  }
  parseTimestamp(input.deployment.observedAt, "software deployment observedAt");
  return input.deployment;
}

export function createSoftwarePostDeploymentVerificationEvidence(
  input: Omit<SoftwarePostDeploymentVerificationEvidence, "source" | "evidenceHash">
): SoftwarePostDeploymentVerificationEvidence {
  if (!input.deploymentEvidenceHash || !input.verificationReceiptId) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Post-deployment verification requires deployment evidence and verification receipt lineage"
    );
  }
  const observedAt = new Date(parseTimestamp(
    input.observedAt,
    "post-deployment verification observedAt"
  )).toISOString();
  const base = {
    ...input,
    source: "verification-service" as const,
    observedAt
  };
  return Object.freeze({ ...base, evidenceHash: sha256Hex(base) });
}

export function assertSoftwarePostDeploymentVerificationEvidence(input: {
  verification: SoftwarePostDeploymentVerificationEvidence;
  plan: SoftwareWorkerPlan;
  expectedDeploymentEvidenceHash: string;
}) {
  const { evidenceHash, ...base } = input.verification;
  if (
    sha256Hex(base) !== evidenceHash
    || input.verification.source !== "verification-service"
    || input.verification.planId !== input.plan.id
    || input.verification.deploymentEvidenceHash !== input.expectedDeploymentEvidenceHash
    || !input.verification.verified
    || !input.verification.verificationReceiptId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Post-deployment verification does not establish independent success evidence"
    );
  }
  parseTimestamp(input.verification.observedAt, "post-deployment verification observedAt");
  return input.verification;
}

export function transitionSoftwarePipeline(input: {
  current: SoftwarePipelineRecord;
  to: SoftwarePipelineState;
  updatedAt: string;
  evidence?: SoftwareChangeEvidence;
  promotion?: ProductionPromotionReceipt;
  deploymentEvidence?: SoftwareDeploymentEvidence;
  postDeploymentVerification?: SoftwarePostDeploymentVerificationEvidence;
  plan: SoftwareWorkerPlan;
}): SoftwarePipelineRecord {
  const { recordHash, ...currentBase } = input.current;
  if (sha256Hex(currentBase) !== recordHash) {
    throw new ControlPlaneError("FORBIDDEN", "Software pipeline record integrity check failed");
  }
  if (input.current.planId !== input.plan.id) {
    throw new ControlPlaneError("FORBIDDEN", "Software pipeline record does not belong to the plan");
  }
  const updatedAtMs = parseTimestamp(input.updatedAt, "software pipeline updatedAt");
  if (updatedAtMs < Date.parse(input.current.updatedAt)) {
    throw new ControlPlaneError("CONFLICT", "Software pipeline time cannot move backwards");
  }
  if (!allowed[input.current.state].includes(input.to)) {
    throw new ControlPlaneError(
      "CONFLICT",
      `Invalid software pipeline transition ${input.current.state} -> ${input.to}`
    );
  }
  if (input.evidence) {
    assertSoftwareChangeEvidenceForPlan(input.evidence, input.plan);
  }
  if (input.to === "staging-verified" && !input.evidence?.stagingVerificationReceiptId) {
    throw new ControlPlaneError("FORBIDDEN", "Staging verification evidence is required");
  }
  if (input.to === "production-authorized") {
    if (!input.promotion || !input.current.evidenceHash) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Production promotion requires approval receipt and exact staged evidence"
      );
    }
    assertProductionPromotionReceipt(
      input.promotion,
      input.plan,
      updatedAtMs,
      input.current.evidenceHash
    );
  }
  if (input.to === "production-deployed") {
    if (
      !input.current.productionPromotionReceiptHash
      || !input.current.evidenceHash
      || !input.deploymentEvidence
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Production deployment requires prior authorization and deployment evidence"
      );
    }
    assertSoftwareDeploymentEvidence({
      deployment: input.deploymentEvidence,
      plan: input.plan,
      expectedEvidenceHash: input.current.evidenceHash,
      expectedPromotionReceiptHash: input.current.productionPromotionReceiptHash
    });
  }
  if (input.to === "post-deploy-verifying" && !input.current.deploymentEvidenceHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Post-deploy verification requires accepted deployment evidence"
    );
  }
  if (input.to === "succeeded") {
    if (!input.current.deploymentEvidenceHash || !input.postDeploymentVerification) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Software success requires independent post-deployment verification"
      );
    }
    assertSoftwarePostDeploymentVerificationEvidence({
      verification: input.postDeploymentVerification,
      plan: input.plan,
      expectedDeploymentEvidenceHash: input.current.deploymentEvidenceHash
    });
  }

  const base = {
    planId: input.current.planId,
    state: input.to,
    updatedAt: new Date(updatedAtMs).toISOString(),
    evidenceHash: input.evidence?.evidenceHash ?? input.current.evidenceHash,
    productionPromotionReceiptHash:
      input.promotion?.receiptHash ?? input.current.productionPromotionReceiptHash,
    deploymentEvidenceHash:
      input.deploymentEvidence?.deploymentEvidenceHash ?? input.current.deploymentEvidenceHash,
    postDeploymentVerificationHash:
      input.postDeploymentVerification?.evidenceHash ?? input.current.postDeploymentVerificationHash,
    deploymentReference:
      input.deploymentEvidence?.deploymentReference ?? input.current.deploymentReference
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
    deploymentEvidenceHash: undefined,
    postDeploymentVerificationHash: undefined,
    deploymentReference: undefined
  };
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}
