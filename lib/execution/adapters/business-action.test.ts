import { describe, expect, it } from "vitest";
import { DevelopmentMockBusinessActionAdapter } from "@/lib/execution/adapters/development-mock-business-action";
import { assertBusinessActionAdapterConformance } from "@/lib/execution/adapters/business-action-conformance";
import { assertAuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";

const request = {
  id: "action-1",
  jobId: "job-1",
  scope: {
    userId: "owner",
    portfolioId: "portfolio",
    companyId: "company",
    environment: "development" as const
  },
  capability: "email.send",
  input: { messageRef: "payload-1" },
  inputHash: "input-hash",
  authorizationConsumptionHash: "auth-hash",
  idempotencyKey: "action:1",
  timeoutMs: 30000,
  attempt: 1
};

describe("Phase 20 business action adapter contracts", () => {
  it("conformance keeps provider acceptance non-authoritative for Job truth", async () => {
    const adapter = new DevelopmentMockBusinessActionAdapter();
    const result = await assertBusinessActionAdapterConformance({ adapter, request });
    expect(result.status).toBe("accepted");
    expect(result.jobStateMutationApplied).toBe(false);
  });

  it("requires authorization and idempotency lineage", () => {
    expect(() => assertAuthorizedBusinessActionRequest({
      ...request,
      authorizationConsumptionHash: ""
    })).toThrow(/authorized/i);
  });

  it("requires a credential lease reference for production side effects", () => {
    expect(() => assertAuthorizedBusinessActionRequest({
      ...request,
      scope: { ...request.scope, environment: "production" as const }
    })).toThrow(/credential lease/i);
  });
});
