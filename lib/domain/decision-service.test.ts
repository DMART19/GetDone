import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditLedger } from "@/lib/domain/audit";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { AuthoritativeDecision, DecisionAuthorityStore } from "@/lib/domain/decision-service";
import { resolveDecision } from "@/lib/domain/decision-service";
import type { DecisionTransaction, DecisionTransactionManager } from "@/lib/domain/decision-transaction";
import type { IdempotencyClaim, IdempotencyRecord, IdempotencyStore } from "@/lib/domain/idempotency";
import { createStepUpProof, type StepUpProof } from "@/lib/authorization/proofs";
import type { ApprovalRecord } from "@/lib/domain/services/approval-service";
import type { EntityStore } from "@/lib/domain/services/common";

class MemoryDecisionTransactionManager implements DecisionTransactionManager {
  private decisionValue: AuthoritativeDecision;
  private approvalValue?: ApprovalRecord;
  private auditEvents: AuditEvent[] = [];
  private idempotencyRecords = new Map<string, IdempotencyRecord>();
  failAudit = false;

  constructor(
    initialDecision: AuthoritativeDecision,
    initialApproval?: ApprovalRecord
  ) {
    this.decisionValue = { ...initialDecision };
    this.approvalValue = initialApproval ? { ...initialApproval } : undefined;
  }

  decision() { return { ...this.decisionValue }; }
  approval() { return this.approvalValue ? { ...this.approvalValue } : undefined; }
  events() { return [...this.auditEvents]; }
  idempotency(key: string) { return this.idempotencyRecords.get(key); }

  async run<T>(operation: (transaction: DecisionTransaction) => Promise<T>): Promise<T> {
    let stagedDecision = { ...this.decisionValue };
    let stagedApproval = this.approvalValue ? { ...this.approvalValue } : undefined;
    const stagedEvents = [...this.auditEvents];
    const stagedIdempotency = new Map(this.idempotencyRecords);

    const decisions: DecisionAuthorityStore = {
      get: async (id) => id === stagedDecision.id ? { ...stagedDecision } : null,
      save: async (next, expectedVersion) => {
        if (stagedDecision.version !== expectedVersion) throw new Error("optimistic concurrency conflict");
        stagedDecision = { ...next };
      }
    };

    const approvals: EntityStore<ApprovalRecord> = {
      get: async (id) =>
        stagedApproval?.id === id ? { ...stagedApproval } : null,
      save: async (next, expectedVersion) => {
        if (!stagedApproval || stagedApproval.version !== expectedVersion) {
          throw new Error("approval optimistic concurrency conflict");
        }
        stagedApproval = { ...next };
      }
    };

    const audit: AuditLedger = {
      append: async (event) => {
        if (this.failAudit) throw new Error("simulated audit persistence failure");
        stagedEvents.push(event);
      },
      listByCorrelationId: async (correlationId) => stagedEvents.filter((event) => event.correlationId === correlationId)
    };

    const idempotency: IdempotencyStore = {
      async claim<R = unknown>(key: string, fingerprint: string, createdAt: string): Promise<IdempotencyClaim<R>> {
        const existing = stagedIdempotency.get(key) as IdempotencyRecord<R> | undefined;
        if (existing) {
          if (existing.fingerprint !== fingerprint) return { state: "CONFLICT", record: existing };
          return { state: existing.status, record: existing };
        }
        const record: IdempotencyRecord<R> = { key, fingerprint, status: "IN_PROGRESS", createdAt };
        stagedIdempotency.set(key, record as IdempotencyRecord);
        return { state: "CREATED", record };
      },
      async complete<R = unknown>(key: string, fingerprint: string, result: R, completedAt: string) {
        const existing = stagedIdempotency.get(key);
        if (!existing || existing.fingerprint !== fingerprint) throw new Error("idempotency completion conflict");
        const record: IdempotencyRecord<R> = { ...existing, status: "COMPLETED", completedAt, result };
        stagedIdempotency.set(key, record as IdempotencyRecord);
        return record;
      },
      async fail(key: string, fingerprint: string, errorCode: string, failedAt: string) {
        const existing = stagedIdempotency.get(key);
        if (!existing || existing.fingerprint !== fingerprint) throw new Error("idempotency failure conflict");
        const record: IdempotencyRecord = { ...existing, status: "FAILED", failedAt, errorCode };
        stagedIdempotency.set(key, record);
        return record;
      },
      async get<R = unknown>(key: string) {
        return (stagedIdempotency.get(key) as IdempotencyRecord<R> | undefined) ?? null;
      }
    };

    const result = await operation({
      stores: { decisions, approvals },
      audit,
      idempotency
    });
    this.decisionValue = stagedDecision;
    this.approvalValue = stagedApproval;
    this.auditEvents = stagedEvents;
    this.idempotencyRecords = stagedIdempotency;
    return result;
  }
}

function decision(overrides: Partial<AuthoritativeDecision> = {}): AuthoritativeDecision {
  return {
    id: "decision-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    status: "pending",
    version: 1,
    requiresStepUp: false,
    updatedAt: "2026-09-20T16:00:00Z",
    ...overrides
  };
}

function command(companyId = "company-a", action: "approve" | "modify" | "reject" = "approve") {
  return createCommandEnvelope({
    commandId: `decision-command-${companyId}-${action}`,
    actor: { type: "user", id: "user-a" },
    scope: {
      userId: "user-a",
      portfolioId: "portfolio-a",
      companyId,
      environment: "development"
    },
    correlationId: "decision-correlation-1",
    environment: "development",
    idempotencyKey: `decision-action-${companyId}-${action}`,
    provenance: "owner-ui",
    requestedMutation: {
      type: "decision.resolve" as const,
      decisionId: "decision-1",
      action
    }
  });
}

function stepUp(): StepUpProof {
  return createStepUpProof({
    id: "decision-stepup-1",
    actorId: "user-a",
    scope: command().scope,
    method: "passkey",
    authenticatedAt: "2026-09-20T17:59:00Z",
    expiresAt: "2099-01-01T00:00:00Z"
  });
}

function input(transactionManager: DecisionTransactionManager, overrides: Partial<Parameters<typeof resolveDecision>[0]> = {}) {
  return {
    command: command(),
    transactionManager,
    decisionId: "decision-1",
    action: "approve" as const,
    ...overrides
  };
}

describe("decision authority service", () => {
  it("commits decision, audit, and idempotency together", async () => {
    const transactionManager = new MemoryDecisionTransactionManager(decision());
    const result = await resolveDecision(input(transactionManager));

    expect(result.status).toBe("approved");
    expect(transactionManager.decision().version).toBe(2);
    expect(transactionManager.events()).toHaveLength(1);
    expect(transactionManager.idempotency("decision-action-company-a-approve")?.status).toBe("COMPLETED");
  });

  it("does not duplicate a transition on an idempotent retry", async () => {
    const transactionManager = new MemoryDecisionTransactionManager(decision());
    const request = input(transactionManager);

    const first = await resolveDecision(request);
    const retry = await resolveDecision(request);

    expect(retry).toEqual(first);
    expect(transactionManager.events()).toHaveLength(1);
  });

  it("rolls back state and idempotency if audit persistence fails", async () => {
    const transactionManager = new MemoryDecisionTransactionManager(decision());
    transactionManager.failAudit = true;

    await expect(resolveDecision(input(transactionManager))).rejects.toThrow("simulated audit persistence failure");

    expect(transactionManager.decision().status).toBe("pending");
    expect(transactionManager.events()).toHaveLength(0);
    expect(transactionManager.idempotency("decision-action-company-a-approve")).toBeUndefined();
  });

  it("rejects cross-company decision access", async () => {
    const transactionManager = new MemoryDecisionTransactionManager(decision());

    await expect(resolveDecision(input(transactionManager, {
      command: command("company-b", "reject"),
      action: "reject"
    }))).rejects.toThrow();

    expect(transactionManager.decision().status).toBe("pending");
  });

  it("requires a fresh step-up proof for a strong approval", async () => {
    const transactionManager = new MemoryDecisionTransactionManager(decision({ requiresStepUp: true }));

    await expect(resolveDecision(input(transactionManager))).rejects.toThrow();
    expect((await resolveDecision(input(transactionManager, {
      command: createCommandEnvelope({
        ...command(),
        commandId: "decision-command-stepup",
        idempotencyKey: "decision-action-stepup-approve"
      }),
      stepUpProof: stepUp()
    }))).status).toBe("approved");
  });

  it("atomically grants an exact-hash paired Approval with an orchestration Decision", async () => {
    const initial = decision({
      correlationId: "orchestration-corr",
      orchestrationRunId: "run-1",
      planId: "plan-1",
      planHash: "a".repeat(64),
      stepId: "step-1",
      stepHash: "b".repeat(64),
      policySnapshotId: "policy-1",
      policySnapshotHash: "c".repeat(64),
      approvalId: "approval-1",
      approvalRequirement: "approval"
    });
    const approval: ApprovalRecord = {
      id: "approval-1",
      correlationId: "orchestration-corr",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      state: "pending",
      decisionId: "decision-1",
      requirement: "approval",
      version: 1,
      updatedAt: "2026-09-20T16:00:00Z"
    };
    const transactionManager = new MemoryDecisionTransactionManager(initial, approval);
    const resolvedAt = new Date("2026-09-20T18:00:00Z");

    const result = await resolveDecision(input(transactionManager, {
      now: () => resolvedAt
    }));

    expect(result.status).toBe("approved");
    expect(result.approvalProofId).toMatch(/^approval-proof:/);
    expect(result.approvalProofHash).toHaveLength(64);
    expect(transactionManager.approval()).toMatchObject({
      state: "granted",
      grantedBy: "user-a",
      decisionId: "decision-1"
    });
    expect(transactionManager.approval()?.approvalProof).toMatchObject({
      planHash: "a".repeat(64),
      stepHash: "b".repeat(64),
      level: "approval"
    });
    expect(transactionManager.approval()?.approvalProof?.proofHash)
      .toBe(result.approvalProofHash);
    expect(transactionManager.events().map((event) => event.eventType))
      .toEqual(["approval.granted", "decision.approved"]);
  });

  it("denies the paired Approval in the same transaction when the Decision is rejected", async () => {
    const initial = decision({
      orchestrationRunId: "run-1",
      planId: "plan-1",
      planHash: "a".repeat(64),
      stepId: "step-1",
      stepHash: "b".repeat(64),
      policySnapshotId: "policy-1",
      policySnapshotHash: "c".repeat(64),
      approvalId: "approval-1",
      approvalRequirement: "approval"
    });
    const transactionManager = new MemoryDecisionTransactionManager(initial, {
      id: "approval-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      state: "pending",
      decisionId: "decision-1",
      requirement: "approval",
      version: 1,
      updatedAt: "2026-09-20T16:00:00Z"
    });

    const result = await resolveDecision(input(transactionManager, {
      command: command("company-a", "reject"),
      action: "reject"
    }));

    expect(result.status).toBe("rejected");
    expect(transactionManager.approval()?.state).toBe("denied");
  });

  it("persists the exact step-up proof that supports strong Approval authority", async () => {
    const initial = decision({
      requiresStepUp: true,
      orchestrationRunId: "run-1",
      planId: "plan-1",
      planHash: "a".repeat(64),
      stepId: "step-1",
      stepHash: "b".repeat(64),
      policySnapshotId: "policy-1",
      policySnapshotHash: "c".repeat(64),
      approvalId: "approval-1",
      approvalRequirement: "strong-approval"
    });
    const transactionManager = new MemoryDecisionTransactionManager(initial, {
      id: "approval-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      state: "pending",
      decisionId: "decision-1",
      requirement: "strong-approval",
      version: 1,
      updatedAt: "2026-09-20T16:00:00Z"
    });

    await resolveDecision(input(transactionManager, {
      stepUpProof: stepUp(),
      now: () => new Date("2026-09-20T18:00:00Z")
    }));

    expect(transactionManager.approval()?.stepUpProof?.id).toBe("decision-stepup-1");
    expect(transactionManager.approval()?.approvalProof?.stepUpProofId)
      .toBe("decision-stepup-1");
  });

  it("rejects a command whose embedded mutation does not match the requested action", async () => {
    const transactionManager = new MemoryDecisionTransactionManager(decision());
    await expect(resolveDecision(input(transactionManager, {
      command: command("company-a", "reject"),
      action: "approve"
    }))).rejects.toThrow();
  });
});
