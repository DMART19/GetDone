import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  StagingBrowserSafeActionAdapter
} from "@/lib/staging/browser-safe-action.server";

const scope = {
  userId: "owner",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "staging" as const
};

function request() {
  const input = {
    companyId: "company-a",
    operation: "staging.browser.safe",
    payload: { purpose: "test" }
  };
  return {
    id: "request-a",
    correlationId: "corr-a",
    jobId: "job-a",
    scope,
    capability: "http.request",
    input,
    inputHash: sha256Hex(input),
    authorizationConsumptionHash: "consumption-a",
    idempotencyKey: "request-a",
    timeoutMs: 1_000,
    attempt: 1
  };
}

describe("staging browser safe provider", () => {
  it("is unavailable unless explicitly enabled in staging", () => {
    expect(() => new StagingBrowserSafeActionAdapter(
      { query: async () => ({ rows: [], rowCount: 0 }) } as never,
      { GETDONE_RUNTIME_ENV: "production", GETDONE_STAGING_BROWSER_E2E: "true" }
    )).toThrow(/disabled/i);
    expect(() => new StagingBrowserSafeActionAdapter(
      { query: async () => ({ rows: [], rowCount: 0 }) } as never,
      { GETDONE_RUNTIME_ENV: "staging", GETDONE_STAGING_BROWSER_E2E: "false" }
    )).toThrow(/disabled/i);
  });

  it("persists a harmless provider object and verifies it independently", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const db = {
      async query(text: string, values?: readonly unknown[]) {
        calls.push({ text, values });
        if (text.includes("SELECT provider_operation_id")) {
          return {
            rows: [{
              provider_operation_id: "staging-safe:request-a",
              request_id: "request-a",
              job_id: "job-a",
              company_id: "company-a",
              payload_hash: sha256Hex({ purpose: "test" }),
              created_at: "2026-09-24T12:00:00.000Z"
            }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 1 };
      }
    };

    const adapter = new StagingBrowserSafeActionAdapter(
      db as never,
      { GETDONE_RUNTIME_ENV: "staging", GETDONE_STAGING_BROWSER_E2E: "true" },
      () => new Date("2026-09-24T12:00:00.000Z")
    );
    const executed = await adapter.execute(request());
    expect(executed).toMatchObject({
      status: "accepted",
      providerOperationId: "staging-safe:request-a",
      retryable: false
    });
    expect(calls[0]?.text).toContain("staging_browser_provider_objects");

    const status = await adapter.status({
      requestId: "request-a",
      providerOperationId: "staging-safe:request-a"
    });
    expect(status.state).toBe("completed");
  });

  it("rejects any operation outside the dedicated acceptance surface", async () => {
    const adapter = new StagingBrowserSafeActionAdapter(
      { query: async () => ({ rows: [], rowCount: 1 }) } as never,
      { GETDONE_RUNTIME_ENV: "staging", GETDONE_STAGING_BROWSER_E2E: "true" }
    );
    const value = request();
    await expect(adapter.execute({
      ...value,
      input: {
        companyId: "company-a",
        operation: "other.operation",
        payload: {}
      },
      inputHash: sha256Hex({
        companyId: "company-a",
        operation: "other.operation",
        payload: {}
      })
    })).rejects.toThrow(/outside the authorized acceptance scope/i);
  });
});
