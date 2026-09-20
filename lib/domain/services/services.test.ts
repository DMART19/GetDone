import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditLedger } from "@/lib/domain/audit";
import { createRequestContext } from "@/lib/control-plane/request-context";
import type { EntityStore, AuthoritativeEntity } from "@/lib/domain/services/common";
import { GoalService, type GoalRecord } from "@/lib/domain/services/goal-service";
import { ApprovalService, type ApprovalRecord } from "@/lib/domain/services/approval-service";
import { TaskService, type TaskRecord } from "@/lib/domain/services/task-service";
import { JobService, type JobRecord } from "@/lib/domain/services/job-service";
import { OutcomeService, type OutcomeRecord } from "@/lib/domain/services/outcome-service";

class MemoryStore<T extends AuthoritativeEntity> implements EntityStore<T> {
  constructor(private value: T) {}

  async get(id: string) {
    return id === this.value.id ? { ...this.value } : null;
  }

  async save(next: T, expectedVersion: number) {
    if (this.value.version !== expectedVersion) throw new Error("optimistic concurrency conflict");
    this.value = { ...next };
  }
}

class MemoryAudit implements AuditLedger {
  readonly events: AuditEvent[] = [];

  async append(event: AuditEvent) {
    this.events.push(event);
  }

  async listByCorrelationId(correlationId: string) {
    return this.events.filter((event) => event.correlationId === correlationId);
  }
}

const request = createRequestContext({
  actor: { type: "user", id: "user-a" },
  scope: { userId: "user-a", portfolioId: "portfolio-a", companyId: "company-a" },
  environment: "development",
  correlationId: "correlation-domain-services"
});

const base = {
  id: "entity-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  version: 1,
  updatedAt: "2026-09-20T16:00:00Z"
};

describe("domain services", () => {
  it("transitions goals with optimistic versioning and audit", async () => {
    const audit = new MemoryAudit();
    const store = new MemoryStore<GoalRecord>({
      ...base,
      state: "draft",
      title: "Grow",
      metric: "revenue",
      target: 100,
      priority: 1
    });

    const result = await new GoalService(store, audit).activate(base.id, request);
    expect(result.state).toBe("active");
    expect(result.version).toBe(2);
    expect(audit.events[0].eventType).toBe("goal.active");
  });

  it("requires step-up for strong approvals", async () => {
    const service = new ApprovalService(
      new MemoryStore<ApprovalRecord>({
        ...base,
        state: "pending",
        decisionId: "decision-1",
        requirement: "strong-approval"
      }),
      new MemoryAudit()
    );

    await expect(service.grant(base.id, request, false)).rejects.toThrow();
  });

  it("requires verification evidence before task success", async () => {
    const store = new MemoryStore<TaskRecord>({
      ...base,
      state: "verifying",
      reason: "approved plan",
      evidenceIds: ["evidence-1"],
      capabilityRequirements: ["email.send"],
      authorizationLineage: ["approval-1"],
      verificationEvidenceIds: []
    });
    const service = new TaskService(store, new MemoryAudit());

    await expect(service.succeed(base.id, request, [])).rejects.toThrow();
    expect((await service.succeed(base.id, request, ["verify-1"])).state).toBe("succeeded");
  });

  it("requires a claimed worker before a job starts", async () => {
    const store = new MemoryStore<JobRecord>({
      ...base,
      state: "queued",
      taskId: "task-1",
      attempt: 0,
      verificationEvidenceIds: []
    });
    const service = new JobService(store, new MemoryAudit());
    await service.claim(base.id, request, "worker-1");
    expect((await service.start(base.id, request)).state).toBe("running");
  });

  it("does not verify an outcome without evidence", async () => {
    const service = new OutcomeService(
      new MemoryStore<OutcomeRecord>({
        ...base,
        state: "recorded",
        jobId: "job-1",
        metric: "conversion-rate",
        value: 0.12,
        evidenceIds: []
      }),
      new MemoryAudit()
    );

    await expect(service.verify(base.id, request, [])).rejects.toThrow();
  });
});
