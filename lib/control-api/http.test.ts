import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControlApiApplicationAdapter, ControlApiPrincipal } from "@/lib/control-api/contracts";
import {
  handleControlHealth,
  handleDiscoverResource,
  handleAdvanceResourceEnrollment,
  handleGetDecision,
  handleGetResourceEnrollment,
  handleGetJobResult,
  handleGetVerification,
  handleListDecisions,
  handleListJobs,
  handleListResourceEnrollments,
  handleListResources,
  handleListVerifications,
  handleMutateDecision,
  handleOwnerIntent,
  handleStartResourceEnrollment
} from "@/lib/control-api/http";
import {
  installControlApiAdapter,
  resetControlApiAdapter
} from "@/lib/control-api/runtime.server";

const principal: ControlApiPrincipal = {
  actor: { type: "user", id: "user-a" },
  scope: {
    userId: "user-a",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "development"
  },
  sessionId: "session-a",
  role: "owner"
};

const decision = {
  id: "decision-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  status: "pending" as const,
  version: 1,
  requiresStepUp: false,
  updatedAt: "2026-09-21T04:00:00Z"
};

const resource = {
  id: "resource-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  type: "compute" as const,
  state: "discovered" as const,
  environmentPermissions: ["development" as const],
  capabilityNames: [],
  failureDomainIds: [],
  credentialBindingIds: [],
  policyBindingIds: [],
  identityEvidenceIds: [],
  trustEvidenceIds: [],
  healthRecordIds: [],
  capabilityBindingIds: [],
  locationIds: [],
  costProfileIds: [],
  providerBindingIds: [],
  trustClass: "untrusted" as const,
  dataClassesAllowed: ["public" as const],
  createdAt: "2026-09-21T04:00:00Z",
  updatedAt: "2026-09-21T04:00:00Z",
  version: 1
};

const job = {
  id: "job-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  state: "succeeded" as const,
  taskId: "task-1",
  attempt: 1,
  verificationEvidenceIds: ["evidence-1"],
  verificationReceiptId: "receipt-1",
  verificationReceiptHash: "receipt-hash",
  version: 2,
  updatedAt: "2026-09-21T04:00:00Z"
};

const enrollment = {
  id: "enrollment-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  state: "identify" as const,
  requestedType: "compute" as const,
  requestedEnvironments: ["development" as const],
  ownerActionRequired: false,
  challengeHash: "challenge-hash",
  challengeIssuedAt: "2026-09-21T04:00:00Z",
  challengeExpiresAt: "2099-01-01T00:00:00Z",
  evidenceIds: [],
  attempt: 1,
  version: 1,
  updatedAt: "2026-09-21T04:00:00Z"
};

const verification = {
  id: "verification-1",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  state: "requested" as const,
  request: {
    id: "request-1"
  } as never,
  version: 1,
  updatedAt: "2026-09-21T04:00:00Z"
};

function fakeAdapter(): ControlApiApplicationAdapter {
  return {
    authenticate: async () => principal,
    beginStepUp: async () => ({
      challengeId: "challenge-1",
      expiresAt: "2099-01-01T00:00:00Z",
      method: "provider"
    }),
    verifyStepUp: async () => ({
      sessionId: "session-a",
      userId: "user-a",
      stepUpAuthenticatedAt: "2026-09-21T04:00:00Z"
    }),
    health: async () => ({
      service: "getdone-control-api",
      surfaceVersion: "1.1.0",
      status: "ready",
      authConnected: true,
      persistenceConnected: true,
      aiGatewayAdapterInstalled: true,
      durableJobStoreConnected: true
    }),
    submitOwnerIntent: async (_principal, input) => ({
      id: "intent-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "development",
      userId: "user-a",
      message: input.message,
      channel: input.channel ?? "chat",
      status: "accepted",
      receivedAt: "2026-09-21T04:00:00Z"
    }),
    listDecisions: async () => [decision],
    getDecision: async (_principal, id) => id === decision.id ? decision : null,
    mutateDecision: async (_principal, input) => ({
      ...decision,
      status: input.action === "approve" ? "approved" : input.action === "modify" ? "modified" : "rejected",
      version: 2
    }),
    listResources: async () => [resource],
    getResource: async (_principal, id) => id === resource.id ? resource : null,
    discoverResource: async (_principal, input) => ({ ...resource, id: input.id, type: input.type }),
    listResourceEnrollments: async () => [enrollment],
    getResourceEnrollment: async (_principal, id) => id === enrollment.id ? enrollment : null,
    startResourceEnrollment: async (_principal, input) => ({
      ...enrollment,
      id: input.id,
      requestedType: input.requestedType
    }),
    advanceResourceEnrollment: async (_principal, id, input) => ({
      ...enrollment,
      id,
      state: input.action === "create" ? "create-enrollment" : enrollment.state
    }),
    listJobs: async () => [job],
    getJob: async (_principal, id) => id === job.id ? job : null,
    getJobResult: async (_principal, id) => id === job.id ? {
      jobId: job.id,
      state: job.state,
      verificationEvidenceIds: job.verificationEvidenceIds,
      verificationReceiptId: job.verificationReceiptId,
      verificationReceiptHash: job.verificationReceiptHash
    } : null,
    listVerifications: async () => [verification],
    getVerification: async (_principal, id) => id === verification.id ? verification : null
  };
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  process.env.GETDONE_RUNTIME_ENV = "development";
  installControlApiAdapter(fakeAdapter());
});

afterEach(() => {
  resetControlApiAdapter();
});

describe("Control API HTTP surface", () => {
  it("returns explicit health and no-store envelopes", async () => {
    const response = await handleControlHealth();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await json(response)).toMatchObject({
      ok: true,
      environment: "development",
      data: { service: "getdone-control-api", status: "ready" }
    });
  });

  it("defaults to fail-closed unavailable runtime when no adapter is installed", async () => {
    resetControlApiAdapter();
    const health = await handleControlHealth();
    expect(await json(health)).toMatchObject({
      ok: true,
      data: { status: "unavailable", persistenceConnected: false }
    });

    const blocked = await handleListDecisions(new Request("http://localhost/api/control/decisions"));
    expect(blocked.status).toBe(503);
    expect(await json(blocked)).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" }
    });
  });

  it("accepts owner intent only with valid JSON and an idempotency key", async () => {
    const missingKey = await handleOwnerIntent(new Request("http://localhost/api/control/intents", {
      method: "POST",
      body: JSON.stringify({ message: "Move the company forward" })
    }));
    expect(missingKey.status).toBe(400);

    const invalid = await handleOwnerIntent(new Request("http://localhost/api/control/intents", {
      method: "POST",
      headers: { "idempotency-key": "intent-key-123" },
      body: "{not-json"
    }));
    expect(invalid.status).toBe(400);

    const schemaInvalid = await handleOwnerIntent(new Request("http://localhost/api/control/intents", {
      method: "POST",
      headers: { "idempotency-key": "intent-key-124" },
      body: JSON.stringify({ message: "" })
    }));
    expect(schemaInvalid.status).toBe(400);

    const accepted = await handleOwnerIntent(new Request("http://localhost/api/control/intents", {
      method: "POST",
      headers: { "idempotency-key": "intent-key-125" },
      body: JSON.stringify({ message: "Move the company forward", channel: "api" })
    }));
    expect(accepted.status).toBe(202);
    expect(await json(accepted)).toMatchObject({
      ok: true,
      data: { message: "Move the company forward", channel: "api", status: "accepted" }
    });
  });

  it("serves scoped Decision reads and mutation contracts", async () => {
    const list = await handleListDecisions(new Request("http://localhost/api/control/decisions"));
    expect(await json(list)).toMatchObject({ ok: true, data: [{ id: "decision-1" }] });

    const missing = await handleGetDecision(
      new Request("http://localhost/api/control/decisions/missing"),
      "missing"
    );
    expect(missing.status).toBe(404);

    const unsafe = await handleGetDecision(
      new Request("http://localhost/api/control/decisions/x"),
      "../other"
    );
    expect(unsafe.status).toBe(400);

    const invalidAction = await handleMutateDecision(
      new Request("http://localhost/api/control/decisions/decision-1", {
        method: "PATCH",
        headers: { "idempotency-key": "decision-key-1" },
        body: JSON.stringify({ action: "force" })
      }),
      "decision-1"
    );
    expect(invalidAction.status).toBe(400);

    const approved = await handleMutateDecision(
      new Request("http://localhost/api/control/decisions/decision-1", {
        method: "PATCH",
        headers: { "idempotency-key": "decision-key-2" },
        body: JSON.stringify({ action: "approve" })
      }),
      "decision-1"
    );
    expect(await json(approved)).toMatchObject({ ok: true, data: { status: "approved" } });
  });

  it("exposes Resource enrollment through the adapter instead of route-local persistence", async () => {
    const list = await handleListResources(new Request("http://localhost/api/control/resources"));
    expect(await json(list)).toMatchObject({ ok: true, data: [{ id: "resource-1" }] });

    const discovered = await handleDiscoverResource(new Request("http://localhost/api/control/resources", {
      method: "POST",
      headers: { "idempotency-key": "resource-key-1" },
      body: JSON.stringify({ id: "resource-new", type: "compute", capabilityNames: ["http"] })
    }));
    expect(discovered.status).toBe(201);
    expect(await json(discovered)).toMatchObject({ ok: true, data: { id: "resource-new", type: "compute" } });

    const started = await handleStartResourceEnrollment(new Request("http://localhost/api/control/resources/enroll", {
      method: "POST",
      headers: { "idempotency-key": "enrollment-key-1" },
      body: JSON.stringify({
        id: "enrollment-new",
        requestedType: "compute",
        ownerActionRequired: false,
        challengeToken: "one-time-challenge-value",
        challengeExpiresAt: "2099-01-01T00:00:00Z"
      })
    }));
    expect(started.status).toBe(201);
    expect(await json(started)).toMatchObject({ ok: true, data: { id: "enrollment-new", state: "identify" } });

    expect((await json(await handleListResourceEnrollments(
      new Request("http://localhost/api/control/resource-enrollments")
    )))).toMatchObject({ ok: true, data: [{ id: "enrollment-1" }] });

    expect(await json(await handleGetResourceEnrollment(
      new Request("http://localhost/api/control/resource-enrollments/enrollment-1"),
      "enrollment-1"
    ))).toMatchObject({ ok: true, data: { id: "enrollment-1" } });

    const advanced = await handleAdvanceResourceEnrollment(
      new Request("http://localhost/api/control/resource-enrollments/enrollment-1/actions", {
        method: "POST",
        headers: { "idempotency-key": "enrollment-key-2" },
        body: JSON.stringify({ action: "create" })
      }),
      "enrollment-1"
    );
    expect(await json(advanced)).toMatchObject({ ok: true, data: { state: "create-enrollment" } });
  });

  it("exposes Jobs, verified result views, and Verification reads", async () => {
    expect(await json(await handleListJobs(
      new Request("http://localhost/api/control/jobs")
    ))).toMatchObject({ ok: true, data: [{ id: "job-1" }] });

    const result = await handleGetJobResult(
      new Request("http://localhost/api/control/jobs/job-1/result"),
      "job-1"
    );
    expect(await json(result)).toMatchObject({
      ok: true,
      data: { jobId: "job-1", state: "succeeded", verificationReceiptId: "receipt-1" }
    });

    expect(await json(await handleListVerifications(
      new Request("http://localhost/api/control/verifications")
    ))).toMatchObject({ ok: true, data: [{ id: "verification-1" }] });

    const missingVerification = await handleGetVerification(
      new Request("http://localhost/api/control/verifications/missing"),
      "missing"
    );
    expect(missingVerification.status).toBe(404);
  });
});
