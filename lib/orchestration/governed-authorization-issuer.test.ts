import { describe, expect, it } from "vitest";
import type { AuthorizationGrant } from "@/lib/authorization/grants";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import type { OrchestrationExecutionArtifactStore } from "@/lib/orchestration/execution-artifact-store";
import type {
  OrchestrationExecutionArtifact,
  OrchestrationExecutionArtifactKind
} from "@/lib/orchestration/execution-artifacts";
import { GovernedAuthorizationIssuer } from "@/lib/orchestration/governed-authorization-issuer";
import type { OrchestrationPlanningArtifactStore } from "@/lib/orchestration/planning-artifact-store";
import {
  createGovernedPlanArtifact,
  createPlanValidationArtifact,
  createPolicyBundleArtifact,
  type OrchestrationPlanningArtifact,
  type OrchestrationPlanningArtifactKind
} from "@/lib/orchestration/planning-artifacts";
import { hashPlan, hashPlanStep } from "@/lib/planning/plan-hash";
import { validPlan } from "@/lib/planning/test-fixture";
import {
  attestationFor,
  autoPolicyFor,
  fixtureNow,
  policySnapshotFor,
  validationPolicyFor
} from "@/lib/planning/test-security-fixture";

class MemoryPlanning implements OrchestrationPlanningArtifactStore {
  constructor(private readonly artifacts: OrchestrationPlanningArtifact[]) {}
  async append(_run: OrchestrationRun, artifact: OrchestrationPlanningArtifact) {
    this.artifacts.push(artifact);
    return { created: true };
  }
  private latest(kind: OrchestrationPlanningArtifactKind) {
    return [...this.artifacts].reverse().find((item) => item.kind === kind);
  }
  async latestContext() {
    const value = this.latest("context-snapshot");
    return value?.kind === "context-snapshot" ? value.value : null;
  }
  async latestPlan() {
    const value = this.latest("plan-proposal");
    return value?.kind === "plan-proposal" ? value.value : null;
  }
  async latestValidation() {
    const value = this.latest("validation-attestation");
    return value?.kind === "validation-attestation" ? value.value : null;
  }
  async latestPolicy() {
    const value = this.latest("policy-bundle");
    return value?.kind === "policy-bundle" ? value.value : null;
  }
  async count(_run: OrchestrationRun, kind: OrchestrationPlanningArtifactKind) {
    return this.artifacts.filter((item) => item.kind === kind).length;
  }
}

class MemoryExecution implements OrchestrationExecutionArtifactStore {
  readonly artifacts: OrchestrationExecutionArtifact[] = [];
  async append(_run: OrchestrationRun, artifact: OrchestrationExecutionArtifact) {
    const existing = this.artifacts.find((item) => item.value.id === artifact.value.id);
    if (!existing) this.artifacts.push(artifact);
    return { created: !existing };
  }
  private latest(kind: OrchestrationExecutionArtifactKind) {
    return [...this.artifacts].reverse().find((item) => item.kind === kind);
  }
  async latestValidationReceipt() {
    const value = this.latest("validation-receipt");
    return value?.kind === "validation-receipt" ? value.value : null;
  }
  async latestAuthorizationBundle() {
    const value = this.latest("authorization-bundle");
    return value?.kind === "authorization-bundle" ? value.value : null;
  }
  async latestTaskDag() {
    const value = this.latest("task-dag");
    return value?.kind === "task-dag" ? value.value : null;
  }
  async latestJobBatch() {
    const value = this.latest("job-batch");
    return value?.kind === "job-batch" ? value.value : null;
  }
  async count(_run: OrchestrationRun, kind: OrchestrationExecutionArtifactKind) {
    return this.artifacts.filter((item) => item.kind === kind).length;
  }
}

function run(): OrchestrationRun {
  return Object.freeze({
    id: "orchestration:owner-intent:intent-1",
    correlationId: "corr-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging",
    authorityUserId: "user-a",
    initiatingActor: Object.freeze({ type: "user" as const, id: "user-a" }),
    source: Object.freeze({ kind: "owner-intent" as const, ownerIntentId: "intent-1" }),
    state: "policy-cleared",
    attempt: 1,
    version: 6,
    availableAt: fixtureNow.toISOString(),
    createdAt: fixtureNow.toISOString(),
    updatedAt: fixtureNow.toISOString()
  });
}

function planningArtifacts() {
  const plan = validPlan();
  const planHash = hashPlan(plan);
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
    plannedAt: fixtureNow.toISOString()
  });
  const attestation = attestationFor(plan, fixtureNow);
  const validation = createPlanValidationArtifact({
    id: "validation-artifact-1",
    runId: run().id,
    correlationId: run().correlationId,
    planArtifactId: planArtifact.id,
    planHash,
    attestation,
    createdAt: fixtureNow.toISOString()
  });
  const snapshot = policySnapshotFor(plan, plan.steps[0].id, fixtureNow);
  const evaluation = autoPolicyFor(plan, plan.steps[0].id);
  const policy = createPolicyBundleArtifact({
    id: "policy-artifact-1",
    runId: run().id,
    correlationId: run().correlationId,
    planArtifactId: planArtifact.id,
    planHash,
    validationArtifactId: validation.id,
    validationAttestationHash: attestation.attestationHash,
    strongestDisposition: evaluation.disposition,
    ownerDecisionRequired: false,
    stepPolicies: [{
      stepId: plan.steps[0].id,
      stepHash: hashPlanStep(plan.steps[0]),
      snapshot,
      evaluation
    }],
    createdAt: fixtureNow.toISOString()
  });
  return {
    plan,
    planning: new MemoryPlanning([
      { kind: "plan-proposal", value: planArtifact },
      { kind: "validation-attestation", value: validation },
      { kind: "policy-bundle", value: policy }
    ])
  };
}

function validationConstraints() {
  const full = validationPolicyFor(validPlan());
  const { trustedScope: _trustedScope, ...constraints } = full;
  return constraints;
}

describe("GovernedAuthorizationIssuer", () => {
  it("issues exact grants from fresh policy, checkpoints the bundle, and reuses it on retry", async () => {
    const { plan, planning } = planningArtifacts();
    const execution = new MemoryExecution();
    const grants = new Map<string, AuthorizationGrant>();
    let policyLoads = 0;

    const issuer = new GovernedAuthorizationIssuer(
      planning,
      execution,
      {
        getDecision: async () => null,
        getApproval: async () => null
      },
      {
        load: async () => ({
          kind: "ready" as const,
          constraints: validationConstraints()
        })
      },
      {
        load: async () => {
          policyLoads += 1;
          return {
            kind: "ready" as const,
            evidence: {
              region: "us-west",
              killSwitches: [],
              credentialRequirementIds: [],
              fallbackAvailable: true
            }
          };
        }
      },
      {
        load: async () => ({
          kind: "ready" as const,
          configurationVersion: "config-v1"
        })
      },
      {
        insert: async (grant) => {
          const prior = grants.get(grant.id);
          if (prior && prior.grantHash !== grant.grantHash) {
            throw new Error("grant conflict");
          }
          grants.set(grant.id, grant);
        },
        get: async (id) => grants.get(id) ?? null
      },
      {},
      () => fixtureNow
    );

    const first = await issuer.authorize(run());
    expect(first.kind).toBe("authorized");
    if (first.kind !== "authorized") throw new Error("expected authorized");
    expect(first.grants).toHaveLength(plan.steps.length);
    expect(first.grants[0]).toMatchObject({
      planHash: hashPlan(plan),
      stepId: plan.steps[0].id,
      status: "active"
    });
    expect(await execution.count(run(), "validation-receipt")).toBe(1);
    expect(await execution.count(run(), "authorization-bundle")).toBe(1);

    const firstGrantHash = first.grants[0].grantHash;
    const second = await issuer.authorize(run());
    expect(second.kind).toBe("authorized");
    if (second.kind !== "authorized") throw new Error("expected authorized retry");
    expect(second.grants[0].grantHash).toBe(firstGrantHash);
    expect(await execution.count(run(), "authorization-bundle")).toBe(1);
    expect(policyLoads).toBe(1);
  });

  it("blocks grant issuance when fresh policy now has an active kill switch", async () => {
    const { planning } = planningArtifacts();
    const issuer = new GovernedAuthorizationIssuer(
      planning,
      new MemoryExecution(),
      {
        getDecision: async () => null,
        getApproval: async () => null
      },
      {
        load: async () => ({
          kind: "ready" as const,
          constraints: validationConstraints()
        })
      },
      {
        load: async () => ({
          kind: "ready" as const,
          evidence: {
            region: "us-west",
            killSwitches: [{
              id: "kill-repository",
              scopeType: "capability" as const,
              scopeId: "repository.inspect",
              enabled: true,
              reason: "incident",
              activatedAt: new Date(fixtureNow.getTime() - 1_000).toISOString(),
              activatedBy: "owner"
            }],
            credentialRequirementIds: [],
            fallbackAvailable: true
          }
        })
      },
      {
        load: async () => ({
          kind: "ready" as const,
          configurationVersion: "config-v1"
        })
      },
      {
        insert: async () => undefined,
        get: async () => null
      },
      {},
      () => fixtureNow
    );

    await expect(issuer.authorize(run())).resolves.toMatchObject({
      kind: "blocked",
      reason: "fresh-policy-blocked:step-1"
    });
  });
});
