import { describe, expect, it } from "vitest";
import { issueAuthorizationGrant, assertAuthorizationGrant } from "@/lib/authorization/grants";
import type { ApprovalProof, StepUpProof } from "@/lib/authorization/proofs";
import { hashPlan, hashPlanStep } from "@/lib/planning/plan-hash";
import { createPolicySnapshot } from "@/lib/planning/policy-snapshot";
import { evaluateStepPolicy } from "@/lib/planning/policy-engine";
import { validPlan } from "@/lib/planning/test-fixture";
import { fixtureNow, fixtureScope, receiptFor, autoGrantFor } from "@/lib/planning/test-security-fixture";

describe("authorization grants", () => {
  it("issues an immutable AUTO grant bound to plan, step, receipt and policy snapshot", () => {
    const plan = validPlan();
    const receipt = receiptFor(plan);
    const grant = autoGrantFor(plan, plan.steps[0].id, receipt);

    expect(grant.disposition).toBe("AUTO");
    expect(grant.planHash).toBe(hashPlan(plan));
    expect(grant.stepHash).toBe(hashPlanStep(plan.steps[0]));
    expect(grant.validationReceiptHash).toBe(receipt.receiptHash);
    expect(grant.grantHash).toHaveLength(64);
    expect(Object.isFrozen(grant)).toBe(true);
  });

  it("rejects grant reuse after the plan step mutates", () => {
    const plan = validPlan();
    const receipt = receiptFor(plan);
    const grant = autoGrantFor(plan, plan.steps[0].id, receipt);
    const mutated = {
      ...plan,
      steps: [{ ...plan.steps[0], reason: "changed after authorization" }]
    };

    expect(() => assertAuthorizationGrant({
      grant,
      plan: mutated,
      stepId: mutated.steps[0].id,
      receipt,
      scope: fixtureScope(plan),
      now: fixtureNow.getTime()
    })).toThrow();
  });

  it("rejects expired grants", () => {
    const plan = validPlan();
    const receipt = receiptFor(plan);
    const grant = autoGrantFor(plan, plan.steps[0].id, receipt);

    expect(() => assertAuthorizationGrant({
      grant,
      plan,
      stepId: plan.steps[0].id,
      receipt,
      scope: fixtureScope(plan),
      now: Date.parse("2026-09-20T18:31:00Z")
    })).toThrow();
  });

  it("issues STRONG_APPROVAL only from matching approval and step-up proofs", () => {
    const base = validPlan();
    const productionPlan = {
      ...base,
      scope: {
        ...base.scope,
        environment: "production" as const,
        dataClass: "sensitive" as const
      },
      requestedCapabilities: ["production.deploy"],
      steps: [{
        ...base.steps[0],
        capabilityRequests: [{
          capability: "production.deploy",
          input: {
            companyId: "company-a",
            repository: "DMART19/GetDone",
            commitSha: "abcdef1",
            environment: "production",
            deploymentId: "deploy-1",
            rollbackRef: "previous",
            verificationChecks: ["health"]
          }
        }],
        resourceRequirements: {
          ...base.steps[0].resourceRequirements,
          execution: {
            ...base.steps[0].resourceRequirements.execution,
            environment: "production" as const
          },
          data: {
            ...base.steps[0].resourceRequirements.data,
            classification: "sensitive" as const
          }
        }
      }]
    };
    const receipt = receiptFor(productionPlan);
    const scope = fixtureScope(productionPlan);
    const step = productionPlan.steps[0];
    const stepUp: StepUpProof = {
      id: "stepup-strong",
      actorId: "user-a",
      scope,
      method: "passkey",
      authenticatedAt: "2026-09-20T18:29:00Z",
      expiresAt: "2026-09-20T18:35:00Z"
    };
    const approval: ApprovalProof = {
      id: "approval-proof-strong",
      decisionId: "decision-1",
      approvalId: "approval-1",
      actorId: "user-a",
      scope,
      level: "strong-approval",
      planHash: hashPlan(productionPlan),
      stepHash: hashPlanStep(step),
      grantedAt: "2026-09-20T18:29:30Z",
      expiresAt: "2026-09-20T18:34:00Z",
      stepUpProofId: stepUp.id
    };
    const policySnapshot = createPolicySnapshot({
      id: "policy-snapshot-strong",
      policyVersion: "policy-v1",
      scope,
      planHash: hashPlan(productionPlan),
      stepHash: hashPlanStep(step),
      capabilityNames: ["production.deploy"],
      dataClass: "sensitive",
      region: "us-west",
      allowedEnvironments: ["production"],
      allowedDataClasses: ["sensitive"],
      allowedRegions: ["us-west"],
      killSwitches: [],
      credentialBindingIds: [],
      credentialBindingsAvailable: true,
      protectedHeadroomSatisfied: true,
      fallbackRequired: false,
      fallbackAvailable: true,
      idempotencyKey: "strong-policy-12345678",
      resourceRequirements: step.resourceRequirements,
      createdAt: fixtureNow.toISOString()
    });
    const policyEvaluation = evaluateStepPolicy({
      authenticated: true,
      scopeResolved: true,
      trustedScope: scope,
      capabilities: ["production.deploy"],
      planHash: hashPlan(productionPlan),
      stepHash: hashPlanStep(step),
      environment: "production",
      dataClass: "sensitive",
      region: "us-west",
      allowedEnvironments: ["production"],
      allowedDataClasses: ["sensitive"],
      allowedRegions: ["us-west"],
      credentialBindingIds: [],
      credentialBindingsAvailable: true,
      credentialBindingRequired: false,
      protectedHeadroomSatisfied: true,
      fallbackRequired: false,
      fallbackAvailable: true,
      idempotencyKey: "strong-policy-12345678",
      killSwitches: [],
      approvalProof: approval,
      stepUpProof: stepUp,
      now: fixtureNow.getTime()
    });

    const grant = issueAuthorizationGrant({
      id: "grant-strong",
      plan: productionPlan,
      stepId: step.id,
      receipt,
      policySnapshot,
      policyEvaluation,
      actor: { type: "user", id: "user-a" },
      scope,
      approvalProof: approval,
      stepUpProof: stepUp,
      issuedAt: fixtureNow.toISOString(),
      expiresAt: "2026-09-20T18:33:00Z"
    });

    expect(grant.disposition).toBe("STRONG_APPROVAL");
    expect(grant.approvalProofId).toBe(approval.id);
    expect(grant.stepUpProofId).toBe(stepUp.id);
  });
});
