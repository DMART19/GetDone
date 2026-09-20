import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditLedger } from "@/lib/domain/audit";
import { createRequestContext } from "@/lib/control-plane/request-context";
import type { AuthoritativeDecision, DecisionAuthorityStore } from "@/lib/domain/decision-service";
import { resolveDecision } from "@/lib/domain/decision-service";
import { MemoryIdempotencyStore } from "@/lib/domain/idempotency";

class MemoryDecisionStore implements DecisionAuthorityStore {
  constructor(private value: AuthoritativeDecision) {}

  async get(id: string) {
    return id === this.value.id ? { ...this.value } : null;
  }

  async save(next: AuthoritativeDecision, expectedVersion: number) {
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

describe("decision authority service", () => {
  it("records an authorized decision transition and audit event", async () => {
    const store = new MemoryDecisionStore(decision());
    const audit = new MemoryAudit();
    const idempotency = new MemoryIdempotencyStore();

    const result = await resolveDecision({
      context: context(),
      store,
      audit,
      idempotency,
      idempotencyKey: "decision-action-123",
      decisionId: "decision-1",
      action: "approve",
      stepUpSatisfied: false
    });

    expect(result.status).toBe("approved");
    expect(result.version).toBe(2);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0].previousState).toBe("pending");
    expect(audit.events[0].newState).toBe("approved");
  });

  it("does not duplicate a transition on an idempotent retry", async () => {
    const store = new MemoryDecisionStore(decision());
    const audit = new MemoryAudit();
    const idempotency = new MemoryIdempotencyStore();
    const input = {
      context: context(),
      store,
      audit,
      idempotency,
      idempotencyKey: "decision-action-123",
      decisionId: "decision-1",
      action: "approve" as const,
      stepUpSatisfied: false
    };

    const first = await resolveDecision(input);
    const retry = await resolveDecision(input);

    expect(retry).toEqual(first);
    expect(audit.events).toHaveLength(1);
  });

  it("rejects cross-company decision access", async () => {
    await expect(resolveDecision({
      context: context("company-b"),
      store: new MemoryDecisionStore(decision()),
      audit: new MemoryAudit(),
      idempotency: new MemoryIdempotencyStore(),
      idempotencyKey: "decision-action-456",
      decisionId: "decision-1",
      action: "reject",
      stepUpSatisfied: false
    })).rejects.toThrow();
  });

  it("requires fresh step-up for a strong approval", async () => {
    await expect(resolveDecision({
      context: context(),
      store: new MemoryDecisionStore(decision({ requiresStepUp: true })),
      audit: new MemoryAudit(),
      idempotency: new MemoryIdempotencyStore(),
      idempotencyKey: "decision-action-789",
      decisionId: "decision-1",
      action: "approve",
      stepUpSatisfied: false
    })).rejects.toThrow();
  });
});
