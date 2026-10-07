import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  createBusinessActionAdapterResult,
  createBusinessActionStatus,
  type AuthorizedBusinessActionRequest,
  type BusinessActionAdapter
} from "@/lib/execution/adapters/business-action";
import { StaticBusinessActionAdapterRegistry } from "@/lib/execution/adapters/business-action-registry";
import {
  BusinessActionExecutionOrchestrator,
  type BusinessActionExecutionRecord,
  type BusinessActionExecutionStore
} from "@/lib/execution/business-action-orchestrator";

const payload = { messageRef: "payload-1" };
const request: AuthorizedBusinessActionRequest = {
  id: "action-1",
  jobId: "job-1",
  scope: {
    userId: "owner",
    portfolioId: "portfolio",
    companyId: "company",
    environment: "staging"
  },
  capability: "email.send",
  input: payload,
  inputHash: sha256Hex(payload),
  authorizationConsumptionHash: "authorization-consumption",
  idempotencyKey: "business-action-1",
  timeoutMs: 30_000,
  attempt: 1
};

class MemoryExecutionStore implements BusinessActionExecutionStore {
  value: BusinessActionExecutionRecord | null = null;

  async get(id: string) {
    return this.value?.requestId === id ? this.value : null;
  }

  async save(record: BusinessActionExecutionRecord, expected?: string) {
    if (this.value && expected !== this.value.recordHash) {
      throw new Error("CAS conflict");
    }
    this.value = record;
  }
}

class SequencedAdapter implements BusinessActionAdapter {
  readonly id = "mail-adapter";
  readonly version = "1.0.0";
  executeCalls = 0;
  statusCalls = 0;
  states: Array<"pending" | "running" | "completed" | "failed" | "cancelled"> = ["pending"];

  async execute(value: AuthorizedBusinessActionRequest) {
    this.executeCalls += 1;
    return createBusinessActionAdapterResult({
      source: "business-action-adapter",
      requestId: value.id,
      adapterId: this.id,
      adapterVersion: this.version,
      status: "accepted",
      providerOperationId: "provider-op-1",
      retryable: true,
      observedAt: "2026-09-21T04:00:01Z"
    });
  }

  async status(input: { requestId: string; providerOperationId: string }) {
    const state = this.states[Math.min(this.statusCalls, this.states.length - 1)];
    this.statusCalls += 1;
    return createBusinessActionStatus({
      source: "business-action-adapter",
      requestId: input.requestId,
      providerOperationId: input.providerOperationId,
      adapterId: this.id,
      adapterVersion: this.version,
      state,
      observedAt: `2026-09-21T04:00:0${Math.min(9, this.statusCalls + 1)}Z`
    });
  }

  async cancel(input: { requestId: string; providerOperationId: string; reason: string }) {
    return createBusinessActionStatus({
      source: "business-action-adapter",
      requestId: input.requestId,
      providerOperationId: input.providerOperationId,
      adapterId: this.id,
      adapterVersion: this.version,
      state: "cancelled",
      observedAt: "2026-09-21T04:00:09Z"
    });
  }
}

describe("BusinessActionExecutionOrchestrator", () => {
  it("executes once, persists provider lineage, and emits completion evidence", async () => {
    const adapter = new SequencedAdapter();
    adapter.states = ["running", "completed"];
    const store = new MemoryExecutionStore();
    const orchestrator = new BusinessActionExecutionOrchestrator(
      new StaticBusinessActionAdapterRegistry([{ capability: "email.send", adapter }]),
      store,
      { maxStatusPolls: 3, pollIntervalMs: 0 }
    );

    const result = await orchestrator.execute(request);
    expect(adapter.executeCalls).toBe(1);
    expect(result.record.state).toBe("completed");
    expect(result.record.providerOperationId).toBe("provider-op-1");
    expect(result.verificationEvidence).toMatchObject({
      strategy: "business",
      result: "pass",
      subject: { type: "job", id: "job-1" }
    });
  });

  it("resumes polling persisted accepted work without repeating the side effect", async () => {
    const adapter = new SequencedAdapter();
    adapter.states = ["pending", "completed"];
    const store = new MemoryExecutionStore();
    const registry = new StaticBusinessActionAdapterRegistry([
      { capability: "email.send", adapter }
    ]);

    const first = new BusinessActionExecutionOrchestrator(
      registry,
      store,
      { maxStatusPolls: 1, pollIntervalMs: 0 }
    );
    expect((await first.execute(request)).record.state).toBe("pending");
    expect(adapter.executeCalls).toBe(1);

    const resumed = new BusinessActionExecutionOrchestrator(
      registry,
      store,
      { maxStatusPolls: 2, pollIntervalMs: 0 }
    );
    const result = await resumed.execute(request);
    expect(result.record.state).toBe("completed");
    expect(adapter.executeCalls).toBe(1);
  });

  it("rejects idempotency collisions and missing capability adapters", async () => {
    const adapter = new SequencedAdapter();
    const store = new MemoryExecutionStore();
    const orchestrator = new BusinessActionExecutionOrchestrator(
      new StaticBusinessActionAdapterRegistry([{ capability: "email.send", adapter }]),
      store,
      { maxStatusPolls: 1, pollIntervalMs: 0 }
    );
    await orchestrator.execute(request);
    await expect(orchestrator.execute({
      ...request,
      input: { messageRef: "other" },
      inputHash: sha256Hex({ messageRef: "other" })
    })).rejects.toThrow(/different authorized input/i);

    const missing = new BusinessActionExecutionOrchestrator(
      new StaticBusinessActionAdapterRegistry([]),
      new MemoryExecutionStore()
    );
    await expect(missing.execute(request)).rejects.toThrow(/No business action adapter/i);
  });

  it("cancels through the same persisted provider operation lineage", async () => {
    const adapter = new SequencedAdapter();
    const store = new MemoryExecutionStore();
    const registry = new StaticBusinessActionAdapterRegistry([
      { capability: "email.send", adapter }
    ]);
    const orchestrator = new BusinessActionExecutionOrchestrator(
      registry,
      store,
      { maxStatusPolls: 1, pollIntervalMs: 0 }
    );
    await orchestrator.execute(request);
    const result = await orchestrator.cancel(request, "owner cancelled");
    expect(result.record.state).toBe("cancelled");
    expect(result.verificationEvidence?.result).toBe("fail");
  });

  it("routes execute and status calls through provider concurrency admission", async () => {
    const adapter = new SequencedAdapter();
    adapter.states = ["completed"];
    const operations: string[] = [];
    const orchestrator = new BusinessActionExecutionOrchestrator(
      new StaticBusinessActionAdapterRegistry([{ capability: "email.send", adapter }]),
      new MemoryExecutionStore(),
      {
        maxStatusPolls: 1,
        pollIntervalMs: 0,
        providerConcurrencyGate: {
          withPermit: async (input, operation) => {
            operations.push(`${input.providerKey}:${input.operation}`);
            return operation();
          }
        }
      }
    );

    await orchestrator.execute(request);
    expect(operations).toEqual([
      "mail-adapter:execute",
      "mail-adapter:status"
    ]);
  });

  it("redispatches a retryable pre-acceptance failure with the same authorized idempotency lineage", async () => {
    class RetryableAdapter extends SequencedAdapter {
      override async execute(value: AuthorizedBusinessActionRequest) {
        this.executeCalls += 1;
        if (this.executeCalls === 1) {
          return createBusinessActionAdapterResult({
            source: "business-action-adapter",
            requestId: value.id,
            adapterId: this.id,
            adapterVersion: this.version,
            status: "failed",
            retryable: true,
            retryClass: "rate-limit",
            observedAt: "2026-09-21T04:00:01Z"
          });
        }
        return createBusinessActionAdapterResult({
          source: "business-action-adapter",
          requestId: value.id,
          adapterId: this.id,
          adapterVersion: this.version,
          status: "accepted",
          providerOperationId: "provider-op-after-retry",
          retryable: false,
          retryClass: "none",
          observedAt: "2026-09-21T04:00:02Z"
        });
      }
    }
    const adapter = new RetryableAdapter();
    adapter.states = ["completed"];
    const store = new MemoryExecutionStore();
    const registry = new StaticBusinessActionAdapterRegistry([
      { capability: "email.send", adapter }
    ]);
    const first = await new BusinessActionExecutionOrchestrator(
      registry,
      store,
      { maxStatusPolls: 1, pollIntervalMs: 0 }
    ).execute(request);
    expect(first.record).toMatchObject({ state: "failed", retryable: true });
    const second = await new BusinessActionExecutionOrchestrator(
      registry,
      store,
      { maxStatusPolls: 1, pollIntervalMs: 0 }
    ).execute(request);
    expect(second.record.state).toBe("completed");
    expect(adapter.executeCalls).toBe(2);
  });

  it("rejects duplicate capability bindings", () => {
    const adapter = new SequencedAdapter();
    expect(() => new StaticBusinessActionAdapterRegistry([
      { capability: "email.send", adapter },
      { capability: "email.send", adapter }
    ])).toThrow(/multiple adapters/i);
  });

  it("releases credentials on every call and preserves completion if cleanup fails", async () => {
    const adapter = Object.assign(new SequencedAdapter(), { credentialRequirement: () => ({ providerId: "provider", requiredScopes: ["send"] }) });
    adapter.states = ["completed"];
    const release = vi.fn().mockRejectedValue(new Error("cleanup unavailable"));
    const store = new MemoryExecutionStore();
    const orchestrator = new BusinessActionExecutionOrchestrator(new StaticBusinessActionAdapterRegistry([{ capability: "email.send", adapter }]), store, {
      maxStatusPolls: 1, pollIntervalMs: 0,
      credentialBroker: { resolve: async () => ({ leaseId: "lease", leaseHash: "lease-hash", providerId: "provider", capability: "email.send", grantedScopes: ["send"], material: "ephemeral-fixture", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }), release }
    });
    expect((await orchestrator.execute(request)).record.state).toBe("completed");
    expect(release).toHaveBeenCalledTimes(2);
    expect((await orchestrator.execute(request)).record.state).toBe("completed");
    expect(adapter.executeCalls).toBe(1);
    expect(JSON.stringify(store.value)).not.toContain("ephemeral-fixture");
  });
});
