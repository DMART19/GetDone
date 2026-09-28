import { describe, expect, it } from "vitest";
import type { AuditEvent } from "@/lib/domain/audit";
import type { AuthoritativeDecision } from "@/lib/domain/decision-service";
import type { ApprovalRecord } from "@/lib/domain/services/approval-service";
import { DecisionApprovalMaterializer } from "@/lib/orchestration/decision-approval-materializer";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import {
  createGovernedPlanArtifact,
  createPolicyBundleArtifact
} from "@/lib/orchestration/planning-artifacts";
import { evaluateStepPolicy } from "@/lib/planning/policy-engine";
import { createPolicySnapshot } from "@/lib/planning/policy-snapshot";
import { hashPlan, hashPlanStep } from "@/lib/planning/plan-hash";
import { validPlan } from "@/lib/planning/test-fixture";
import { CURRENT_POLICY_VERSION } from "@/lib/domain/policy-registry";

function run(): OrchestrationRun {
  return Object.freeze({
    id: "run-1",
    correlationId: "corr-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging",
    authorityUserId: "user-a",
    initiatingActor: Object.freeze({ type: "user" as const, id: "user-a" }),
    source: Object.freeze({ kind: "owner-intent" as const, ownerIntentId: "intent-1" }),
    state: "awaiting-approval",
    attempt: 1,
    version: 6,
    availableAt: "2026-09-27T21:00:00.000Z",
    createdAt: "2026-09-27T20:00:00.000Z",
    updatedAt: "2026-09-27T21:00:00.000Z"
  });
}

function authorityArtifacts() {
  const base = validPlan();
  const plan = validPlan({
    requestedCapabilities: ["email.send"],
    steps: [{
      ...base.steps[0],
      capabilityRequests: [{
        capability: "email.send",
        input: {
          companyId: "company-a",
          to: ["owner@example.com"],
          cc: [],
          subject: "Review",
          text: "Ready."
        }
      }]
    }]
  });
  const planHash = hashPlan(plan);
  const step = plan.steps[0];
  const stepHash = hashPlanStep(step);
  const planArtifact = createGovernedPlanArtifact({
    id: "plan-artifact-1",
    runId: run().id,
    correlationId: run().correlationId,
    contextSnapshotId: "context-1",
    contextHash: "c".repeat(64),
    plan,
    planHash,
    aiAudit: { auditHash: "a".repeat(64) } as never,
    route: { decisionHash: "d".repeat(64) } as never,
    plannedAt: "2026-09-27T20:30:00.000Z"
  });
  const snapshot = createPolicySnapshot({
    id: "policy-step-1",
    policyVersion: CURRENT_POLICY_VERSION,
    scope: {
      userId: "user-a",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "staging"
    },
    planHash,
    stepHash,
    capabilityNames: ["email.send"],
    dataClass: "internal",
    region: "us-west",
    allowedEnvironments: ["staging"],
    allowedDataClasses: ["internal"],
    allowedRegions: ["us-west"],
    killSwitches: [],
    credentialRequirementIds: [],
    fallbackRequired: false,
    fallbackAvailable: true,
    idempotencyKey: "approval-policy-step-1",
    resourceRequirements: step.resourceRequirements,
    createdAt: "2026-09-27T20:30:00.000Z"
  });
  const evaluation = evaluateStepPolicy({
    authenticated: true,
    scopeResolved: true,
    trustedScope: snapshot.scope,
    capabilities: snapshot.capabilityNames,
    planHash,
    stepHash,
    environment: "staging",
    dataClass: "internal",
    region: "us-west",
    allowedEnvironments: ["staging"],
    allowedDataClasses: ["internal"],
    allowedRegions: ["us-west"],
    credentialRequirementIds: [],
    fallbackRequired: false,
    fallbackAvailable: true,
    idempotencyKey: snapshot.idempotencyKey,
    killSwitches: []
  });
  const policy = createPolicyBundleArtifact({
    id: "policy-bundle-1",
    runId: run().id,
    correlationId: run().correlationId,
    planArtifactId: planArtifact.id,
    planHash,
    validationArtifactId: "validation-1",
    validationAttestationHash: "v".repeat(64),
    strongestDisposition: evaluation.disposition,
    ownerDecisionRequired: false,
    stepPolicies: [{
      stepId: step.id,
      stepHash,
      snapshot,
      evaluation
    }],
    createdAt: "2026-09-27T20:30:00.000Z"
  });
  return { planArtifact, policy, stepHash };
}

describe("DecisionApprovalMaterializer", () => {
  it("creates one deterministic exact-hash Decision/Approval pair and reuses it on retry", async () => {
    const decisions = new Map<string, AuthoritativeDecision>();
    const approvals = new Map<string, ApprovalRecord>();
    const audit: AuditEvent[] = [];

    const materializer = new DecisionApprovalMaterializer({
      run: async (operation: (transaction: never) => Promise<unknown>) =>
        operation({
          stores: {
            decisions: {
              get: async (id: string) => decisions.get(id) ?? null,
              create: async (value: AuthoritativeDecision) => {
                decisions.set(value.id, value);
              }
            },
            approvals: {
              get: async (id: string) => approvals.get(id) ?? null,
              create: async (value: ApprovalRecord) => {
                approvals.set(value.id, value);
              }
            }
          },
          audit: {
            append: async (event: AuditEvent) => { audit.push(event); }
          },
          idempotency: {}
        } as never)
    } as never, () => new Date("2026-09-27T21:00:00.000Z"));

    const { planArtifact, policy, stepHash } = authorityArtifacts();
    const first = await materializer.ensure({
      run: run(),
      plan: planArtifact,
      policy
    });
    const second = await materializer.ensure({
      run: run(),
      plan: planArtifact,
      policy
    });

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(decisions.size).toBe(1);
    expect(approvals.size).toBe(1);
    expect(audit).toHaveLength(2);

    const binding = first[0];
    const decision = decisions.get(binding.decisionId)!;
    const approval = approvals.get(binding.approvalId)!;
    expect(decision).toMatchObject({
      orchestrationRunId: "run-1",
      planHash: planArtifact.planHash,
      stepHash,
      approvalId: approval.id,
      approvalRequirement: "approval",
      status: "pending"
    });
    expect(approval).toMatchObject({
      decisionId: decision.id,
      requirement: "approval",
      state: "pending"
    });
  });
});
