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
import type { StepUpProof } from "@/lib/authorization/proofs";

class MemoryStore<T extends AuthoritativeEntity> implements EntityStore<T> {
  constructor(public value: T) {}
  async get(id: string) { return id === this.value.id ? { ...this.value } : null; }
  async save(next: T, expectedVersion: number) {
    if (this.value.version !== expectedVersion) throw new Error("optimistic concurrency conflict");
    this.value = { ...next };
  }
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
      environment: "development"
    },
    correlationId: `correlation-${commandCounter}`,
    environment: "development",
    idempotencyKey: `idempotency-${commandCounter}`,
    provenance: "unit-test",
    requestedMutation: { type }
  });
}

const stepUp: StepUpProof = {
  id: "stepup-service",
  actorId: "user-a",
  scope: {
    userId: "user-a",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "development"
  },
  method: "passkey",
  authenticatedAt: "2026-09-20T17:59:00Z",
  expiresAt: "2099-01-01T00:00:00Z"
};

const base = {
  id: "entity-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  version: 1,
  updatedAt: "2026-09-20T16:00:00Z"
};

describe("transactional domain services", () => {
  it("transitions goals through the universal transaction boundary", async () => {
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

  it("requires a real step-up proof for strong approvals", async () => {
    const store = new MemoryStore<ApprovalRecord>({
      ...base, state: "pending", decisionId: "decision-1", requirement: "strong-approval"
    });
    const service = new ApprovalService(manager<ApprovalStores>({ approvals: store }));
    await expect(service.grant(base.id, command("approval.grant"))).rejects.toThrow();
    const granted = await service.grant(base.id, command("approval.grant"), stepUp);
    expect(granted.state).toBe("granted");
  });

  it("requires verification evidence before task success", async () => {
    const store = new MemoryStore<TaskRecord>({
      ...base, state: "verifying", reason: "approved plan", evidenceIds: ["evidence-1"],
      capabilityRequirements: ["email.send"], authorizationLineage: ["approval-1"], verificationEvidenceIds: []
    });
    const service = new TaskService(manager<TaskStores>({ tasks: store }));
    expect(() => service.succeed(base.id, command("task.succeed"), [])).toThrow();
    expect((await service.succeed(base.id, command("task.succeed"), ["verify-1"])).state).toBe("succeeded");
  });

  it("requires a claimed worker before a job starts", async () => {
    const store = new MemoryStore<JobRecord>({
      ...base, state: "queued", taskId: "task-1", attempt: 0, verificationEvidenceIds: []
    });
    const service = new JobService(manager<JobStores>({ jobs: store }));
    await service.claim(base.id, command("job.claim"), "worker-1");
    expect((await service.start(base.id, command("job.start"))).state).toBe("running");
  });

  it("does not verify an outcome without evidence", async () => {
    const store = new MemoryStore<OutcomeRecord>({
      ...base, state: "recorded", jobId: "job-1", metric: "conversion-rate", value: 0.12, evidenceIds: []
    });
    const service = new OutcomeService(manager<OutcomeStores>({ outcomes: store }));
    expect(() => service.verify(base.id, command("outcome.verify"), [])).toThrow();
  });
});
