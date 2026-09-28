import { describe, expect, it } from "vitest";
import {
  createCredentialBinding,
  createCredentialRequest,
  createSecretReference,
  issueCredentialLease
} from "@/lib/credentials/broker";
import type { OrchestrationRunRecord } from "@/lib/orchestration/contracts";
import {
  PostgresOrchestrationCredentialLeaseResolver,
  readAuthoritativeOrchestrationRuntimeConfig
} from "@/lib/orchestration/orchestration-worker-runtime.server";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";
import type { GeneratedTask } from "@/lib/planning/task-generator";

function fakeDatabase(rows: readonly unknown[]): PostgresTransactionalDatabase {
  return {
    async query() {
      return {
        command: "SELECT",
        rowCount: rows.length,
        oid: 0,
        fields: [],
        rows
      };
    },
    async transaction() {
      throw new Error("transaction not expected");
    }
  } as unknown as PostgresTransactionalDatabase;
}

const scope = {
  userId: "owner-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production" as const,
  resourceId: "resource-a",
  dataClass: "internal" as const
};

function run() {
  return {
    scope
  } as unknown as OrchestrationRunRecord;
}

function task() {
  return {
    scope
  } as unknown as GeneratedTask;
}

function activeLease() {
  const secret = createSecretReference({
    id: "secret-a",
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    providerId: "provider-a",
    environment: "production",
    purpose: "production action",
    backendRef: "vault://provider-a/prod",
    status: "active",
    rotationVersion: 1
  });
  const binding = createCredentialBinding({
    id: "binding-a",
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    providerId: "provider-a",
    environment: "production",
    secretReferenceId: secret.id,
    capabilityNames: ["production.deploy"],
    grantedScopes: [],
    allowedResourceIds: [scope.resourceId],
    status: "active"
  });
  const request = createCredentialRequest({
    id: "credential-request-a",
    jobId: "job-a",
    placementRequestId: "placement-a",
    scope,
    resourceId: scope.resourceId,
    resourceState: "ready",
    resourceLocationClass: "cloud",
    providerId: "provider-a",
    capability: "production.deploy",
    requestedScopes: [],
    requestedAt: "2026-09-28T22:00:00.000Z",
    expiresAt: "2026-09-28T22:10:00.000Z"
  });
  return issueCredentialLease({
    leaseId: "lease-a",
    request,
    secret,
    binding,
    deliveryRef: "delivery://lease-a",
    issuedAt: "2026-09-28T22:01:00.000Z",
    ttlSeconds: 300
  });
}

describe("authoritative orchestration worker runtime", () => {
  it("uses finite fail-closed production ceilings", () => {
    const config = readAuthoritativeOrchestrationRuntimeConfig({});
    expect(config.maxPlanCostCents).toBe(10_000);
    expect(config.maxStepCostCents).toBe(5_000);
    expect(config.aiCompanyDailyBudgetCents).toBe(5_000);
    expect(config.aiPortfolioDailyBudgetCents).toBe(20_000);
    expect(config.aiConcurrencyLimit).toBe(2);
    expect(config.validationTtlSeconds).toBe(300);
  });

  it("rejects a step ceiling greater than the plan ceiling", () => {
    expect(() => readAuthoritativeOrchestrationRuntimeConfig({
      GETDONE_ORCHESTRATION_MAX_PLAN_COST_CENTS: "100",
      GETDONE_ORCHESTRATION_MAX_STEP_COST_CENTS: "101"
    })).toThrow(/step cost ceiling/i);
  });

  it("rejects unlimited or non-positive budget configuration", () => {
    expect(() => readAuthoritativeOrchestrationRuntimeConfig({
      GETDONE_AI_COMPANY_DAILY_BUDGET_CENTS: "0"
    })).toThrow(/positive integer/i);
  });

  it("reuses only an authoritative active lease for production dispatch", async () => {
    const lease = activeLease();
    const resolver = new PostgresOrchestrationCredentialLeaseResolver(
      fakeDatabase([{ payload: lease }]),
      () => new Date("2026-09-28T22:02:00.000Z")
    );

    await expect(resolver.resolve({
      run: run(),
      task: task(),
      jobId: "job-a",
      capability: "production.deploy"
    })).resolves.toBe("lease-a");
  });

  it("fails closed when multiple active leases match one production Job", async () => {
    const lease = activeLease();
    const resolver = new PostgresOrchestrationCredentialLeaseResolver(
      fakeDatabase([{ payload: lease }, { payload: lease }]),
      () => new Date("2026-09-28T22:02:00.000Z")
    );

    await expect(resolver.resolve({
      run: run(),
      task: task(),
      jobId: "job-a",
      capability: "production.deploy"
    })).rejects.toThrow(/multiple active credential leases/i);
  });

  it("does not resolve a production credential without trusted resource scope", async () => {
    const resolver = new PostgresOrchestrationCredentialLeaseResolver(
      fakeDatabase([{ payload: activeLease() }])
    );
    const unboundTask = {
      scope: {
        ...scope,
        resourceId: undefined
      }
    } as unknown as GeneratedTask;

    await expect(resolver.resolve({
      run: run(),
      task: unboundTask,
      jobId: "job-a",
      capability: "production.deploy"
    })).resolves.toBeUndefined();
  });
});
