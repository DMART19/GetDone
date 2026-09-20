import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditLedger } from "@/lib/domain/audit";
import { createRequestContext } from "@/lib/control-plane/request-context";
import type { AuthoritativeDecision, DecisionAuthorityStore } from "@/lib/domain/decision-service";
import { resolveDecision } from "@/lib/domain/decision-service";
import type { DecisionTransaction, DecisionTransactionManager } from "@/lib/domain/decision-transaction";
import type { IdempotencyRecord, IdempotencyStore } from "@/lib/domain/idempotency";

class MemoryDecisionTransactionManager implements DecisionTransactionManager {
  private decisionValue: AuthoritativeDecision;
  private auditEvents: AuditEvent[] = [];
  private idempotencyRecords = new Map<string, IdempotencyRecord>();
  failAudit = false;

  constructor(initialDecision: AuthoritativeDecision) {
    this.decisionValue = { ...initialDecision };
  }

  decision() {
    return { ...this.decisionValue };
  }

  events() {
    return [...this.auditEvents];
  }

  idempotency(key: string) {
    return this.idempotencyRecords.get(key);
  }

  async run<T>(operation: (transaction: DecisionTransaction) => Promise<T>): Promise<T> {
    let stagedDecision = { ...this.decisionValue };
    const stagedEvents = [...this.auditEvents];
    const stagedIdempotency = new Map(this.idempotencyRecords);

    const decisions: DecisionAuthorityStore = {
      get: async (id) => id === stagedDecision.id ? { ...stagedDecision } : null,
      save: async (next, expectedVersion) => {
        if (stagedDecision.version !== expectedVersion) throw new Error("optimistic concurrency conflict");
        stagedDecision = { ...next };
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
      get: async <R = unknown>(key: string) => {
        return (stagedIdempotency.get(key) as IdempotencyRecord<R> | undefined) ?? null;
      },
      put: async <R = unknown>(record: IdempotencyRecord<R>) => {
        stagedIdempotency.set(record.key, record as IdempotencyRecord);
      }
    };

    const result = await operation({ decisions, audit, idempotency });
    this.decisionValue = stagedDecision;
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

function context(companyId = "company-a") {
  return createRequestContext({
    actor: { type: "user", id: "user-a" },
    scope: { userId: "user-a", portfolioId: "portfolio-a", companyId },
    environment: "development",
    correlationId: "correlation-1"
  });
}

function input(transactionManager: DecisionTransactionManager, overrides: Partial<Parameters<typeof resolveDecision>[0]> = {}) {
  return {
    context: context(),
    transactionManager,
    idempotencyKey: "decision-action-123",
    decisionId: "decision-1",
    action: "approve" as const,
    stepUpSatisfied: false,
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
    expect(transactionManager.idempotency("decision-action-123")?.status).toBe("completed");
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
    expect(transactionManager.decision().version).toBe(1);
    expect(transactionManager.events()).toHaveLength(0);
    expect(transactionManager.idempotency("decision-action-123")).toBeUndefined();
  });

  it("rejects cross-company decision access without committing an idempotency claim", async () => {
    const transactionManager = new MemoryDecisionTransactionManager(decision());

    await expect(resolveDecision(input(transactionManager, {
      context: context("company-b"),
      action: "reject"
    }))).rejects.toThrow();

    expect(transactionManager.decision().status).toBe("pending");
    expect(transactionManager.idempotency("decision-action-123")).toBeUndefined();
  });

  it("requires fresh step-up for a strong approval", async () => {
    const transactionManager = new MemoryDecisionTransactionManager(decision({ requiresStepUp: true }));

    await expect(resolveDecision(input(transactionManager))).rejects.toThrow();
    expect(transactionManager.decision().status).toBe("pending");
  });
});
