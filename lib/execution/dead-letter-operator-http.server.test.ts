import { beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneError } from "@/lib/control-plane/errors";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  act: vi.fn()
}));

vi.mock("@/lib/control-api/runtime.server", () => ({
  getControlApiAdapter: () => ({
    authenticate: mocks.authenticate
  })
}));

vi.mock("@/lib/execution/dead-letter-operator.server", () => ({
  getDeadLetterOperatorServiceFromEnv: () => ({
    list: mocks.list,
    get: mocks.get,
    act: mocks.act
  })
}));

import {
  handleDeadLetterAction,
  handleGetDeadLetter,
  handleListDeadLetters
} from "@/lib/execution/dead-letter-operator-http.server";

const principal = Object.freeze({
  actor: { type: "user" as const, id: "owner-http" },
  scope: {
    userId: "owner-http",
    portfolioId: "portfolio-http",
    companyId: "company-http",
    environment: "staging" as const
  },
  sessionId: "session-http",
  role: "owner" as const
});

function request(
  path: string,
  init: RequestInit = {}
) {
  return new Request("https://getdone.test" + path, init);
}

async function body(response: Response) {
  return response.json() as Promise<{
    ok: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  }>;
}

describe("dead-letter operator HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue(principal);
    mocks.list.mockResolvedValue([]);
    mocks.get.mockResolvedValue({ jobId: "job-dead" });
    mocks.act.mockResolvedValue({
      action: "dismiss",
      sourceJobId: "job-dead",
      status: "completed",
      occurredAt: "2026-09-23T20:00:00.000Z"
    });
  });

  it("returns the authenticated owner/admin dead-letter list with no-store semantics", async () => {
    const response = await handleListDeadLetters(request("/api/control/jobs/dead-letters"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await body(response)).toMatchObject({ ok: true, data: [] });
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith(principal);
  });

  it("returns detail and maps a missing dead letter to 404", async () => {
    const found = await handleGetDeadLetter(
      request("/api/control/jobs/dead-letters/job-dead"),
      "job-dead"
    );
    expect(found.status).toBe(200);
    expect(await body(found)).toMatchObject({
      ok: true,
      data: { jobId: "job-dead" }
    });

    mocks.get.mockResolvedValueOnce(null);
    const missing = await handleGetDeadLetter(
      request("/api/control/jobs/dead-letters/missing"),
      "missing"
    );
    expect(missing.status).toBe(404);
    expect(await body(missing)).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" }
    });
  });

  it("rejects invalid identifiers and propagates authenticated authorization errors", async () => {
    const invalid = await handleGetDeadLetter(
      request("/api/control/jobs/dead-letters/bad"),
      "bad/job"
    );
    expect(invalid.status).toBe(400);
    expect(await body(invalid)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" }
    });

    mocks.list.mockRejectedValueOnce(
      new ControlPlaneError("FORBIDDEN", "owner/admin required")
    );
    const forbidden = await handleListDeadLetters(
      request("/api/control/jobs/dead-letters")
    );
    expect(forbidden.status).toBe(403);
    expect(await body(forbidden)).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: "owner/admin required" }
    });
  });

  it("requires valid JSON, a valid action body, and an idempotency key", async () => {
    const malformed = await handleDeadLetterAction(
      request("/api/control/jobs/dead-letters/job-dead/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{"
      }),
      "job-dead"
    );
    expect(malformed.status).toBe(400);
    expect(await body(malformed)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" }
    });

    const invalidAction = await handleDeadLetterAction(
      request("/api/control/jobs/dead-letters/job-dead/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "replay", reason: "unsafe" })
      }),
      "job-dead"
    );
    expect(invalidAction.status).toBe(400);

    const missingKey = await handleDeadLetterAction(
      request("/api/control/jobs/dead-letters/job-dead/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "dismiss", reason: "reviewed" })
      }),
      "job-dead"
    );
    expect(missingKey.status).toBe(400);
    expect(await body(missingKey)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" }
    });
    expect(mocks.act).not.toHaveBeenCalled();
  });

  it("forwards safe retry/cancel/dismiss actions with the trusted principal and request idempotency", async () => {
    mocks.act.mockResolvedValueOnce({
      action: "retry",
      sourceJobId: "job-dead",
      replacementJobId: "job-replacement",
      requestId: "request-replacement",
      status: "completed",
      occurredAt: "2026-09-23T20:00:00.000Z"
    });
    const response = await handleDeadLetterAction(
      request("/api/control/jobs/dead-letters/job-dead/actions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "retry-http-0001"
        },
        body: JSON.stringify({
          action: "retry",
          reason: "approved fresh lineage",
          replacementJobId: "job-replacement",
          credentialLeaseId: "lease-replacement"
        })
      }),
      "job-dead"
    );
    expect(response.status).toBe(202);
    expect(await body(response)).toMatchObject({
      ok: true,
      data: {
        action: "retry",
        replacementJobId: "job-replacement"
      }
    });
    expect(mocks.act).toHaveBeenCalledWith(principal, "job-dead", {
      action: "retry",
      reason: "approved fresh lineage",
      replacementJobId: "job-replacement",
      credentialLeaseId: "lease-replacement",
      idempotencyKey: "retry-http-0001"
    });
  });
});
