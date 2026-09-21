import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { DevelopmentMockBusinessActionAdapter } from "@/lib/execution/adapters/development-mock-business-action";
import {
  assertBusinessActionAdapterConformance,
  assertBusinessActionCancelConformance
} from "@/lib/execution/adapters/business-action-conformance";
import {
  assertAuthorizedBusinessActionRequest,
  createBusinessActionAdapterResult,
  type AuthorizedBusinessActionRequest,
  type BusinessActionAdapter
} from "@/lib/execution/adapters/business-action";

const payload = { messageRef: "payload-1" };

const request: AuthorizedBusinessActionRequest = {
  id: "action-1",
  jobId: "job-1",
  scope: {
    userId: "owner",
    portfolioId: "portfolio",
    companyId: "company",
    environment: "development" as const
  },
  capability: "email.send",
  input: payload,
  inputHash: sha256Hex(payload),
  authorizationConsumptionHash: "auth-hash",
  idempotencyKey: "action:1",
  timeoutMs: 30000,
  attempt: 1
};

describe("Phase 20 business action adapter contracts", () => {
  it("conformance keeps provider acceptance and completion non-authoritative for Job truth", async () => {
    const adapter = new DevelopmentMockBusinessActionAdapter(
      () => new Date("2026-09-20T22:00:00Z")
    );
    const result = await assertBusinessActionAdapterConformance({ adapter, request });
    expect(result.status).toBe("accepted");
    expect(result.jobStateMutationApplied).toBe(false);
    expect(result.observedAt).toBe("2026-09-20T22:00:00.000Z");
  });

  it("requires authorization and idempotency lineage", () => {
    expect(() => assertAuthorizedBusinessActionRequest({
      ...request,
      authorizationConsumptionHash: ""
    })).toThrow(/authorized/i);
  });

  it("rejects payload tampering after authorization", () => {
    expect(() => assertAuthorizedBusinessActionRequest({
      ...request,
      input: { messageRef: "tampered" }
    })).toThrow(/input hash/i);
  });

  it("requires a credential lease reference for production side effects", () => {
    expect(() => assertAuthorizedBusinessActionRequest({
      ...request,
      scope: { ...request.scope, environment: "production" as const }
    })).toThrow(/credential lease/i);
  });

  it("conformance rejects forged status identity even after provider acceptance", async () => {
    const honest = new DevelopmentMockBusinessActionAdapter(
      () => new Date("2026-09-20T22:00:00Z")
    );
    const forged: BusinessActionAdapter = {
      id: honest.id,
      version: honest.version,
      execute: (value) => honest.execute(value),
      async status(input) {
        const status = await honest.status(input);
        return { ...status, adapterId: "other-adapter" };
      }
    };
    await expect(assertBusinessActionAdapterConformance({
      adapter: forged,
      request
    })).rejects.toThrow();
  });

  it("exercises deterministic cancellation conformance without mutating Job truth", async () => {
    const adapter = new DevelopmentMockBusinessActionAdapter(
      () => new Date("2026-09-20T22:00:05Z")
    );
    const status = await assertBusinessActionCancelConformance({
      adapter,
      request,
      providerOperationId: "mock-operation:action-1",
      reason: "owner cancelled"
    });
    expect(status.state).toBe("cancelled");
    expect(status.jobStateMutationApplied).toBe(false);
  });

  it("requires accepted results to carry provider operation lineage", () => {
    expect(() => createBusinessActionAdapterResult({
      source: "business-action-adapter",
      requestId: request.id,
      adapterId: "adapter",
      adapterVersion: "1.1.0",
      status: "accepted",
      retryable: false,
      observedAt: "2026-09-20T22:00:00Z"
    })).toThrow(/provider operation/i);
  });
});
