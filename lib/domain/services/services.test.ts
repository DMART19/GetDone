import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditLedger } from "@/lib/domain/audit";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import { MemoryIdempotencyStore } from "@/lib/domain/idempotency";
import type { EntityStore, AuthoritativeEntity } from "@/lib/domain/services/common";
import { GoalService, type GoalRecord, type GoalStores } from "@/lib/domain/services/goal-service";
import { ApprovalService, type ApprovalRecord, type ApprovalStores } from "@/lib/domain/services/approval-service";
import { TaskService, type TaskRecord, type TaskStores } from "@/lib/domain/services/task-service";
import { JobService, type JobRecord, type JobStores } from "@/lib/domain/services/job-service";
import { OutcomeService, type OutcomeRecord, type OutcomeStores } from "@/lib/domain/services/outcome-service";
import { createStepUpProof } from "@/lib/authorization/proofs";
import { autoGrantFor, fixtureNow } from "@/lib/planning/test-security-fixture";
import {
  assertAuthorizationConsumption,
  type AuthorizationConsumptionRecord,
  type AuthorizationGrant,
  type AuthorizationGrantStore
} from "@/lib/authorization/grants";
import { validPlan } from "@/lib/planning/test-fixture";
import { hashPlan, hashPlanStep } from "@/lib/planning/plan-hash";
import {
  createVerificationEvidence,
  createVerificationRequest,
  resolveVerificationRequest,
  type VerificationSubjectType,
  type VerificationVerdict
} from "@/lib/verification/verification";

class MemoryStore<T extends AuthoritativeEntity> implements EntityStore<T> {
  constructor(public value: T) {}
  async get(id: string) { return id === this.value.id ? { ...this.value } : null; }
  async save(next: T, expectedVersion: number) {
    if (this.value.version !== expectedVersion) throw new Error("optimistic concurrency conflict");
    this.value = { ...next };
  }
}

class MemoryGrantStore implements AuthorizationGrantStore {
  readonly consumptions: AuthorizationConsumptionRecord[] = [];

  constructor(readonly grant: AuthorizationGrant) {}

  async get(id: string) {
    return id === this.grant.id ? this.grant : null;
  }

  async consume(record: AuthorizationConsumptionRecord) {
    assertAuthorizationConsumption(record, this.grant);
    const existing = this.consumptions.find((item) => item.id === record.id);
    if (existing) {
      if (existing.consumptionHash !== record.consumptionHash) {
        throw new Error("conflicting authorization consumption");
      }
      return;
    }
    if (this.consumptions.length > 0) {
      throw new Error("authorization grant already consumed");
    }
    this.consumptions.push(record);
  }

  async listConsumptions(grantId: string) {
    return this.consumptions.filter((record) => record.grantId === grantId);
  }

  async revoke() {}
}

class MemoryAudit implements AuditLedger {
  readonly events: AuditEvent[] = [];
  fail = false;
  async append(event: AuditEvent) {
    if (this.fail) throw new Error("simulated audit failure");
    this.events.push(event);
  }
  async listByCorrelationId(correlationId: string) {
    return this.events.filter((event) => event.correlationId === correlationId);
  }
}

function manager<TStores>(stores: TStores, audit = new MemoryAudit()): ControlPlaneTransactionManager<TStores> {
  const idempotency = new MemoryIdempotencyStore();
  return { run: async (operation) => operation({ stores, audit, idempotency }) };
}

let commandCounter = 0;
function command(type: string) {
  commandCounter += 1;
  return createCommandEnvelope({
    commandId: `command-${commandCounter}`,
    actor: { type: "user", id: "user-a" },
    scope: {
      userId: "user-a",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "staging"
    },
    correlationId: `correlation-${commandCounter}`,
    environment: "staging",
    idempotencyKey: `idempotency-${commandCounter}`,
    provenance: "unit-test",
    requestedMutation: { type }
  });
}

const stepUp = createStepUpProof({
  id: "stepup-service",
  actorId: "user-a",
  scope: {
    userId: "user-a",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging"
  },
  method: "passkey",
  authenticatedAt: "2026-09-20T17:59:00Z",
  expiresAt: "2099-01-01T00:00:00Z"
});

const base = {
  id: "entity-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  version: 1,
  updatedAt: "2026-09-20T16:00:00Z"
};

function verificationReceipt(
  subjectType: VerificationSubjectType,
  subjectId: string,
  verdict: VerificationVerdict = "verified"
) {
  const request = createVerificationRequest({
    id: "verification-request-" + subjectType + "-" + subjectId + "-" + verdict,
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging",
    subject: { type: subjectType, id: subjectId },
    strategies: ["system"],
    requiresIndependentEvidence: false,
    maxEvidenceAgeSeconds: 3_000_000_000,
    requestedAt: "2026-09-20T19:30:00Z",
    expiresAt: "2099-01-01T00:00:00Z"
  });

  const evidence = createVerificationEvidence({
    id: "verification-evidence-" + subjectType + "-" + subjectId + "-" + verdict,
    portfolioId: "portfolio-a",
    companyId: "company-a",
    subject: { type: subjectType, id: subjectId },
    strategy: "system",
    result: verdict === "verified" ? "pass" : verdict === "failed" ? "fail" : "unknown",
    sourceType: "system-probe",
    sourceId: "independent-verifier",
    independenceKey: "verifier:independent",
    observedAt: "2026-09-20T19:31:00Z",
    payloadHash: "verification-payload-" + verdict,
    provenance: "unit-test"
  });

  return resolveVerificationRequest(request, [evidence], {
    receiptId: "verification-receipt-" + subjectType + "-" + subjectId + "-" + verdict,
    verifiedAt: "2026-09-20T19:31:00Z",
    receiptTtlSeconds: 2_000_000_000
  });
}

describe("transactional domain services", () => {
  it("transitions goals through the universal transition service", async () => {
    const audit = new MemoryAudit();
    const store = new MemoryStore<GoalRecord>({
      ...base, state: "draft", title: "Grow", metric: "revenue", target: 100, priority: 1
    });
    const service = new GoalService(manager<GoalStores>({ goals: store }, audit));
    const result = await service.activate(base.id, command("goal.activate"));
    expect(result.state).toBe("active");
    expect(result.version).toBe(2);
    expect(audit.events[0].eventType).toBe("goal.active");
  });

  it("requires a hash-bound step-up proof for strong approvals", async () => {
    const store = new MemoryStore<ApprovalRecord>({
      ...base, state: "pending", decisionId: "decision-1", requirement: "strong-approval"
    });
    const service = new ApprovalService(manager<ApprovalStores>({ approvals: store }));
    const plan = validPlan();
    const approvalInput = {
      planHash: hashPlan(plan),
      stepHash: hashPlanStep(plan.steps[0]),
      proofExpiresAt: "2098-12-31T23:59:00Z",
      stepUpProof: stepUp
    };
    await expect(service.grant(base.id, command("approval.grant"), { ...approvalInput, stepUpProof: undefined })).rejects.toThrow();
    const granted = await service.grant(base.id, command("approval.grant"), approvalInput);
    expect(granted.state).toBe("granted");
    expect(granted.approvalProof?.decisionId).toBe("decision-1");
    expect(granted.approvalProof?.planHash).toBe(hashPlan(plan));
  });

  it("requires a verified receipt before task success", async () => {
    const store = new MemoryStore<TaskRecord>({
      ...base, state: "verifying", reason: "approved plan", evidenceIds: ["evidence-1"],
      capabilityRequirements: ["email.send"], authorizationLineage: ["approval-1"], verificationEvidenceIds: []
    });
    const service = new TaskService(manager<TaskStores>({ tasks: store }));
    const uncertain = verificationReceipt("task", base.id, "uncertain");
    expect(() => service.succeed(base.id, command("task.succeed.invalid"), uncertain)).toThrow();

    const verified = verificationReceipt("task", base.id, "verified");
    const result = await service.succeed(base.id, command("task.succeed"), verified);
    expect(result.state).toBe("succeeded");
    expect(result.verificationReceiptHash).toBe(verified.receiptHash);
  });

  it("consumes authorization at the Task and lets Jobs inherit only persisted Task authority", async () => {
    const plan = validPlan();
    const grant = autoGrantFor(plan);
    const grants = new MemoryGrantStore(grant);

    const taskStore = new MemoryStore<TaskRecord>({
      id: "task-1",
      portfolioId: plan.scope.portfolioId,
      companyId: plan.scope.companyId,
      state: "proposed",
      reason: "approved work",
      evidenceIds: [],
      capabilityRequirements: [...grant.capabilityNames],
      authorizationLineage: [],
      verificationEvidenceIds: [],
      version: 1,
      updatedAt: fixtureNow.toISOString()
    });
    const taskService = new TaskService(manager<TaskStores>({
      tasks: taskStore,
      authorizationGrants: grants
    }));
    const authorizedTask = await taskService.authorize(
      "task-1",
      command("task.authorize"),
      grant,
      fixtureNow.toISOString()
    );
    expect(authorizedTask.authorizationConsumption?.consumerType).toBe("task");
    expect(grants.consumptions).toHaveLength(1);

    const jobStore = new MemoryStore<JobRecord>({
      ...base,
      state: "created",
      taskId: "task-1",
      attempt: 0,
      verificationEvidenceIds: []
    });
    const jobService = new JobService(manager<JobStores>({
      jobs: jobStore,
      authorizationGrants: grants
    }));
    const queued = await jobService.queue(
      base.id,
      command("job.queue"),
      grant,
      authorizedTask.authorizationConsumption!,
      fixtureNow.toISOString()
    );
    expect(queued.authorizationConsumption?.consumerType).toBe("task");
    expect(queued.authorizationConsumption?.consumerId).toBe("task-1");

    await jobService.claim(base.id, command("job.claim"), "worker-1");
    expect((await jobService.start(base.id, command("job.start"))).state).toBe("running");
  });

  it("does not verify an outcome from an uncertain receipt", async () => {
    const store = new MemoryStore<OutcomeRecord>({
      ...base, state: "recorded", jobId: "job-1", metric: "conversion-rate", value: 0.12, evidenceIds: []
    });
    const service = new OutcomeService(manager<OutcomeStores>({ outcomes: store }));
    const uncertain = verificationReceipt("outcome", base.id, "uncertain");
    expect(() => service.verify(base.id, command("outcome.verify"), uncertain)).toThrow();
  });
});
