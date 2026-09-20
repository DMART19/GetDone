import { describe, expect, it } from "vitest";
import {
  assertApprovalProof,
  assertStepUpProof,
  createApprovalProof,
  createStepUpProof,
  type ApprovalProof,
  type StepUpProof
} from "@/lib/authorization/proofs";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

const now = Date.parse("2026-09-20T18:30:00Z");
const scope: TrustedExecutionScope = {
  userId: "user-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production"
};

function stepUp(overrides: Partial<Omit<StepUpProof, "proofHash">> = {}): StepUpProof {
  return createStepUpProof({
    id: "stepup-1",
    actorId: "user-a",
    scope,
    method: "passkey",
    authenticatedAt: "2026-09-20T18:29:00Z",
    expiresAt: "2026-09-20T18:35:00Z",
    ...overrides
  });
}

function approval(overrides: Partial<Omit<ApprovalProof, "proofHash">> = {}): ApprovalProof {
  return createApprovalProof({
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
  });
}

describe("approval and step-up proofs", () => {
  it("accepts fresh immutable hash-bound proofs", () => {
    const proof = stepUp();
    expect(assertStepUpProof(proof, { actorId: "user-a", scope, now }).id).toBe("stepup-1");
    expect(proof.proofHash).toHaveLength(64);
    expect(Object.isFrozen(proof)).toBe(true);
  });

  it("rejects expired, cross-scope, or tampered step-up proof", () => {
    expect(() => assertStepUpProof(stepUp({ expiresAt: "2026-09-20T18:29:59Z" }), {
      actorId: "user-a", scope, now
    })).toThrow();

    expect(() => assertStepUpProof(stepUp({
      scope: { ...scope, companyId: "company-b" }
    }), { actorId: "user-a", scope, now })).toThrow();

    const valid = stepUp();
    expect(() => assertStepUpProof({ ...valid, actorId: "attacker" }, {
      actorId: "attacker", scope, now
    })).toThrow();
  });

  it("binds strong approval to the exact plan step and step-up proof", () => {
    const proof = approval();
    expect(assertApprovalProof(proof, {
      actorId: "user-a",
      scope,
      planHash: "plan-hash",
      stepHash: "step-hash",
      requiredLevel: "strong-approval",
      now,
      stepUpProof: stepUp()
    }).id).toBe("approval-proof-1");
    expect(proof.proofHash).toHaveLength(64);

    expect(() => assertApprovalProof(proof, {
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
