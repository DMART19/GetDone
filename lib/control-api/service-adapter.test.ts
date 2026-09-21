import { describe, expect, it } from "vitest";
import type { AuthAdapter, AuthSession } from "@/lib/auth/contracts";
import { createStepUpProof } from "@/lib/authorization/proofs";
import type { AuditLedger } from "@/lib/domain/audit";
import type { DecisionAuthorityStore, AuthoritativeDecision } from "@/lib/domain/decision-service";
import type { DecisionTransactionManager } from "@/lib/domain/decision-transaction";
import { MemoryIdempotencyStore } from "@/lib/domain/idempotency";
import { ServiceBackedControlApiAdapter } from "@/lib/control-api/service-adapter";
import { ResourceRegistryService } from "@/lib/domain/services/resource-registry-service";
import type { Resource } from "@/lib/domain/resources";

const session: AuthSession = {
  sessionId: "session-a",
  userId: "user-a",
  issuedAt: "2026-09-21T03:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z",
  authenticatedAt: "2026-09-21T03:00:00Z",
  stepUpAuthenticatedAt: "2026-09-21T03:59:00Z"
};

const scope = {
  userId: "user-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "development" as const
};

function auth(): AuthAdapter {
  return {
    getSession: async () => session,
    revokeSession: async () => undefined,
    beginStepUp: async () => ({
      challengeId: "challenge",
      expiresAt: "2099-01-01T00:00:00Z",
      method: "passkey"
    }),
    verifyStepUp: async () => session
  };
}

class MemoryDecisionManager implements DecisionTransactionManager {
  decision: AuthoritativeDecision = {
    id: "decision-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    status: "pending",
    version: 1,
    requiresStepUp: true,
    updatedAt: "2026-09-21T04:00:00Z"
  };
  private readonly idempotency = new MemoryIdempotencyStore();

  async run<T>(operation: Parameters<DecisionTransactionManager["run"]>[0]): Promise<T> {
    const store: DecisionAuthorityStore = {
      get: async (id) => id === this.decision.id ? { ...this.decision } : null,
      save: async (next, expectedVersion) => {
        if (this.decision.version !== expectedVersion) throw new Error("version conflict");
        this.decision = { ...next };
      }
    };
    const audit: AuditLedger = {
      append: async () => undefined,
      listByCorrelationId: async () => []
    };
    return operation({
      stores: { decisions: store },
      audit,
      idempotency: this.idempotency
    }) as Promise<T>;
  }
}

function resource(id = "resource-1", companyId = "company-a"): Resource {
  return {
    id,
    portfolioId: "portfolio-a",
    companyId,
    type: "compute",
    state: "discovered",
    environmentPermissions: ["development"],
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
    trustClass: "untrusted",
    dataClassesAllowed: ["public"],
    createdAt: "2026-09-21T04:00:00Z",
    updatedAt: "2026-09-21T04:00:00Z",
    version: 1
  };
}

function adapter(overrides: Partial<ConstructorParameters<typeof ServiceBackedControlApiAdapter>[0]> = {}) {
  const decisionTransactions = new MemoryDecisionManager();
  let capturedEnrollment: any;
  const resourceRegistry = {
    discover: async (input: any, command: any) => {
      capturedEnrollment = { input, command };
      return resource(input.id);
    }
  } as unknown as ResourceRegistryService;

  const instance = new ServiceBackedControlApiAdapter({
    auth: auth(),
    scopes: { resolve: async () => scope },
    authorizationEvidence: {
      resolveStepUpProof: async () => createStepUpProof({
        id: "step-up-1",
        actorId: "user-a",
        scope,
        method: "passkey",
        authenticatedAt: "2026-09-21T03:59:00Z",
        expiresAt: "2099-01-01T00:00:00Z"
      })
    },
    intents: { create: async (record) => record },
    decisions: {
      listByScope: async () => [decisionTransactions.decision],
      get: async (id) => id === "decision-1" ? decisionTransactions.decision : null
    },
    decisionTransactions,
    resources: {
      listByScope: async () => [resource()],
      get: async (id) => id === "foreign" ? resource("foreign", "company-b") : id === "resource-1" ? resource() : null
    },
    resourceRegistry,
    jobs: {
      listByScope: async () => [],
      get: async (id) => id === "job-1" ? ({
        id,
        portfolioId: "portfolio-a",
        companyId: "company-a",
        state: "succeeded",
        taskId: "task-1",
        attempt: 1,
        verificationEvidenceIds: ["evidence-1"],
        verificationReceiptId: "receipt-1",
        version: 2,
        updatedAt: "2026-09-21T04:00:00Z"
      }) : null
    },
    verifications: {
      listByScope: async () => [],
      get: async () => null
    },
    health: async () => ({
      service: "getdone-control-api",
      surfaceVersion: "1.0.0",
      status: "ready",
      authConnected: true,
      persistenceConnected: true,
      aiGatewayAdapterInstalled: false,
      durableJobStoreConnected: false
    }),
    now: () => new Date("2026-09-21T04:00:00Z"),
    ...overrides
  });

  return { instance, decisionTransactions, enrollment: () => capturedEnrollment };
}

describe("ServiceBackedControlApiAdapter", () => {
  it("derives principal scope and step-up proof from server-side adapters", async () => {
    const { instance } = adapter();
    const principal = await instance.authenticate(new Request("http://localhost"));
    expect(principal).toMatchObject({
      actor: { type: "user", id: "user-a" },
      scope,
      sessionId: "session-a",
      stepUpProof: { id: "step-up-1" }
    });
  });

  it("rejects a trusted scope that does not belong to the authenticated session", async () => {
    const { instance } = adapter({
      scopes: {
        resolve: async () => ({ ...scope, userId: "different-user" })
      }
    });
    await expect(instance.authenticate(new Request("http://localhost"))).rejects.toThrow(/scope is incomplete/i);
  });

  it("stores owner intent as non-executing accepted input", async () => {
    const { instance } = adapter();
    const principal = await instance.authenticate(new Request("http://localhost"));
    const intent = await instance.submitOwnerIntent(principal, { message: "Investigate churn" }, "intent-key");
    expect(intent).toMatchObject({
      portfolioId: "portfolio-a",
      companyId: "company-a",
      status: "accepted",
      message: "Investigate churn",
      receivedAt: "2026-09-21T04:00:00.000Z"
    });
  });

  it("passes authoritative server-resolved step-up proof into Decision mutation", async () => {
    const { instance, decisionTransactions } = adapter();
    const principal = await instance.authenticate(new Request("http://localhost"));
    const result = await instance.mutateDecision(principal, {
      decisionId: "decision-1",
      action: "approve",
      idempotencyKey: "decision-key-1"
    });
    expect(result.status).toBe("approved");
    expect(decisionTransactions.decision.status).toBe("approved");
  });

  it("hides cross-company entities as NOT_FOUND", async () => {
    const { instance } = adapter();
    const principal = await instance.authenticate(new Request("http://localhost"));
    await expect(instance.getResource(principal, "foreign")).rejects.toThrow(/not found/i);
    expect(await instance.getResource(principal, "missing")).toBeNull();
  });

  it("delegates Resource discovery with environment/data scope narrowed by trusted principal", async () => {
    const { instance, enrollment } = adapter();
    const principal = await instance.authenticate(new Request("http://localhost"));
    const enrolled = await instance.enrollResource(principal, {
      id: "resource-new",
      type: "compute",
      capabilityNames: ["http"],
      idempotencyKey: "resource-key-1"
    });
    expect(enrolled.id).toBe("resource-new");
    expect(enrollment().input).toMatchObject({
      environmentPermissions: ["development"],
      dataClassesAllowed: ["public"]
    });
    expect(enrollment().command.scope).toEqual(scope);
  });

  it("derives Job result views from authoritative Job state", async () => {
    const { instance } = adapter();
    const principal = await instance.authenticate(new Request("http://localhost"));
    expect(await instance.getJobResult(principal, "job-1")).toMatchObject({
      jobId: "job-1",
      state: "succeeded",
      verificationEvidenceIds: ["evidence-1"],
      verificationReceiptId: "receipt-1"
    });
    expect(await instance.getJobResult(principal, "missing")).toBeNull();
  });

  it("exposes health and scoped list/read seams without embedding persistence", async () => {
    const { instance } = adapter();
    const principal = await instance.authenticate(new Request("http://localhost"));
    expect((await instance.health()).status).toBe("ready");
    expect(await instance.listDecisions(principal)).toHaveLength(1);
    expect(await instance.getDecision(principal, "missing")).toBeNull();
    expect(await instance.listResources(principal)).toHaveLength(1);
    expect(await instance.listJobs(principal)).toEqual([]);
    expect(await instance.listVerifications(principal)).toEqual([]);
    expect(await instance.getVerification(principal, "missing")).toBeNull();
  });
});
