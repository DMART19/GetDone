import { describe, expect, it } from "vitest";
import { assertApprovalProof, assertStepUpProof, type ApprovalProof, type StepUpProof } from "@/lib/authorization/proofs";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

const now = Date.parse("2026-09-20T18:30:00Z");
const scope: TrustedExecutionScope = {
  userId: "user-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production"
};

function stepUp(overrides: Partial<StepUpProof> = {}): StepUpProof {
  return {
    id: "stepup-1",
    actorId: "user-a",
    scope,
    method: "passkey",
    authenticatedAt: "2026-09-20T18:29:00Z",
    expiresAt: "2026-09-20T18:35:00Z",
    ...overrides
  };
}

function approval(overrides: Partial<ApprovalProof> = {}): ApprovalProof {
  return {
    id: "approval-proof-1",
    decisionId: "decision-1",
    approvalId: "approval-1",
    actorId: "user-a",
    scope,
    level: "strong-approval",
    planHash: "plan-hash",
    stepHash: "step-hash",
    grantedAt: "2026-09-20T18:29:30Z",
    expiresAt: "2026-09-20T18:34:00Z",
    stepUpProofId: "stepup-1",
    ...overrides
  };
}

describe("approval and step-up proofs", () => {
  it("accepts a fresh matching step-up proof", () => {
    expect(assertStepUpProof(stepUp(), { actorId: "user-a", scope, now }).id).toBe("stepup-1");
  });

  it("rejects expired or cross-scope step-up proof", () => {
    expect(() => assertStepUpProof(stepUp({ expiresAt: "2026-09-20T18:29:59Z" }), {
      actorId: "user-a", scope, now
    })).toThrow();

    expect(() => assertStepUpProof(stepUp({
      scope: { ...scope, companyId: "company-b" }
    }), { actorId: "user-a", scope, now })).toThrow();
  });

  it("binds strong approval to the exact plan step and step-up proof", () => {
    expect(assertApprovalProof(approval(), {
      actorId: "user-a",
      scope,
      planHash: "plan-hash",
      stepHash: "step-hash",
      requiredLevel: "strong-approval",
      now,
      stepUpProof: stepUp()
    }).id).toBe("approval-proof-1");

    expect(() => assertApprovalProof(approval(), {
      actorId: "user-a",
      scope,
      planHash: "different-plan",
      stepHash: "step-hash",
      requiredLevel: "strong-approval",
      now,
      stepUpProof: stepUp()
    })).toThrow();
  });
});
