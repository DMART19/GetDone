import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { getCapability, validateCapabilityInput } from "@/lib/domain/capabilities";
import { assertApprovalProof, type ApprovalProof, type StepUpProof } from "@/lib/authorization/proofs";
import type { PolicyDisposition } from "@/lib/planning/policy-engine";
import { narrowCapabilities, type CapabilityView } from "./capability-map";
import type { OperationScope } from "./contracts";

export interface ExecutionPreview {
  scope: OperationScope; capability: string; workflow: string; resources: readonly string[]; parameters: unknown;
  sideEffects: readonly string[]; nonEffects: readonly string[]; approval: PolicyDisposition;
  expectedResult: string; verificationMethod: string; estimatedCostCents?: number;
  policyHash: string; planHash: string; stepHash: string; createdAt: string; expiresAt: string; previewHash: string;
}
/** Called only with the server's validated registration and persisted policy artifact. */
export function createExecutionPreview(input: {
  scope: OperationScope; registration: CapabilityView; parameters: unknown;
  policy: { disposition: PolicyDisposition; artifactHash: string; planHash: string; stepHash: string };
  now: string; expiresAt: string; estimatedCostCents?: number;
}): ExecutionPreview {
  const { registration: r, policy, scope } = input;
  if (r.status !== "available" || r.companyId !== scope.companyId || policy.disposition === "BLOCKED"
    || !narrowCapabilities.some(v => v.workflow === r.workflow && v.capability === r.capability)
    || !/^[a-f0-9]{64}$/.test(policy.artifactHash) || !/^[a-f0-9]{64}$/.test(policy.planHash) || !/^[a-f0-9]{64}$/.test(policy.stepHash)) {
    throw new ControlPlaneError("POLICY_BLOCKED", "A registered available capability and validated policy artifact are required");
  }
  const parameters = validateCapabilityInput<Record<string, unknown>>(r.capability, input.parameters);
  if (r.action && (typeof parameters.expectedSourceSha !== "string" || !/^[a-f0-9]{40}$/.test(parameters.expectedSourceSha)))
    throw new ControlPlaneError("VALIDATION_FAILED", "Branch preview requires an independently resolved exact source SHA");
  const resource = typeof parameters.repository === "string" ? parameters.repository : typeof parameters.operation === "string" ? parameters.operation : undefined;
  if (parameters.companyId !== scope.companyId || !resource || !r.resources.includes(resource)
    || (scope.resourceId && scope.resourceId !== resource)
    || (parameters.connectionId !== undefined && parameters.connectionId !== r.connectionId)) {
    throw new ControlPlaneError("FORBIDDEN", "Preview parameters exceed the registered business, connection or resource scope");
  }
  const now = Date.parse(input.now), expiry = Date.parse(input.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expiry) || expiry <= now || expiry > now + 15 * 60_000)
    throw new ControlPlaneError("VALIDATION_FAILED", "Preview must expire within fifteen minutes");
  if (input.estimatedCostCents !== undefined && (!Number.isSafeInteger(input.estimatedCostCents) || input.estimatedCostCents < 0))
    throw new ControlPlaneError("VALIDATION_FAILED", "Invalid external cost estimate");
  const write = getCapability(r.capability)?.access === "write";
  const approval: PolicyDisposition = policy.disposition === "STRONG_APPROVAL" ? "STRONG_APPROVAL" : write ? "APPROVAL_REQUIRED" : policy.disposition;
  const base = { scope: { ...scope }, capability: r.capability, workflow: r.workflow, resources: [resource], parameters,
    sideEffects: write ? [`Create exactly one non-protected branch: ${String(parameters.branch)}`] : [],
    nonEffects: ["No merge", "No deletion", "No production deployment", "No publishing", "No email or CRM write"],
    approval, expectedResult: write ? `The new branch references source commit ${String(parameters.expectedSourceSha)}` : "Read-only health evidence",
    verificationMethod: write ? "Independent GitHub API GET comparing branch SHA to approved source SHA" : "Normalize the authorized dated provider read",
    estimatedCostCents: input.estimatedCostCents, policyHash: policy.artifactHash, planHash: policy.planHash,
    stepHash: policy.stepHash, createdAt: input.now, expiresAt: input.expiresAt };
  // JSON clone prevents callers retaining references to the hashed payload.
  const detached = JSON.parse(JSON.stringify(base)) as typeof base;
  return Object.freeze({ ...detached, previewHash: sha256Hex(detached) });
}
export function assertPreviewApproval(preview: ExecutionPreview, current: ExecutionPreview, proof: ApprovalProof,
  scope: OperationScope, now: number, stepUpProof?: StepUpProof) {
  const { previewHash, ...base } = preview;
  const { previewHash: currentHash, ...currentBase } = current;
  if (previewHash !== sha256Hex(base) || currentHash !== sha256Hex(currentBase) || currentHash !== previewHash
    || Date.parse(preview.createdAt) > now || Date.parse(preview.expiresAt) <= now || preview.approval === "BLOCKED"
    || proof.previewHash !== previewHash) throw new ControlPlaneError("FORBIDDEN", "Execution preview changed or expired; a new preview and approval are required");
  assertApprovalProof(proof, { actorId: scope.userId, scope, planHash: preview.planHash, stepHash: preview.stepHash,
    requiredLevel: preview.approval === "STRONG_APPROVAL" ? "strong-approval" : "approval", now, stepUpProof });
}
