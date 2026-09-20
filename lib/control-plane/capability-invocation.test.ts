import { describe, expect, it } from "vitest";
import {
  bindAutonomousCapabilityInvocation,
  bindCapabilityInvocation
} from "@/lib/control-plane/capability-invocation";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

const scope: TrustedExecutionScope = {
  userId: "user-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "staging",
  resourceId: "resource-a"
};

describe("trusted capability invocation", () => {
  it("injects authoritative company scope instead of trusting parameters", () => {
    const bound = bindCapabilityInvocation<{ companyId: string; repository: string }>({
      scope,
      capability: "repository.inspect",
      parameters: {
        repository: "DMART19/GetDone",
        companyId: "company-a"
      },
      correlationId: "correlation-1",
      idempotencyKey: "idem-repository-1"
    });

    expect(bound.input.companyId).toBe("company-a");
    expect(bound.adapterBinding).toBe("software.repository");
  });

  it("rejects a cross-company payload override", () => {
    expect(() => bindCapabilityInvocation({
      scope,
      capability: "repository.inspect",
      parameters: {
        repository: "DMART19/GetDone",
        companyId: "company-b"
      },
      correlationId: "correlation-2",
      idempotencyKey: "idem-repository-2"
    })).toThrow();
  });

  it("rejects a resource override", () => {
    expect(() => bindCapabilityInvocation({
      scope,
      capability: "resource.health.read",
      parameters: {
        companyId: "company-a",
        resourceId: "resource-b"
      },
      correlationId: "correlation-3",
      idempotencyKey: "idem-resource-3"
    })).toThrow();
  });

  it("rejects environment override for environment-bound capabilities", () => {
    expect(() => bindCapabilityInvocation({
      scope: { ...scope, environment: "production" },
      capability: "production.deploy",
      parameters: {
        companyId: "company-a",
        repository: "DMART19/GetDone",
        commitSha: "abcdef1",
        environment: "staging",
        deploymentId: "deploy-1",
        rollbackRef: "previous",
        verificationChecks: ["health"]
      },
      correlationId: "correlation-4",
      idempotencyKey: "idem-deploy-4"
    })).toThrow();
  });

  it("binds authoritative data classification for workload capabilities", () => {
    const bound = bindCapabilityInvocation<{ companyId: string; dataClass: string }>({
      scope,
      capability: "compute.cpu.light",
      dataClass: "customer",
      parameters: {
        companyId: "company-a",
        workloadId: "work-1",
        environment: "staging",
        dataClass: "customer",
        cpuCores: 2,
        memoryMb: 1024,
        durationSeconds: 60,
        workloadType: "test"
      },
      correlationId: "correlation-5",
      idempotencyKey: "idem-compute-5"
    });
    expect(bound.input.dataClass).toBe("customer");
  });

  it("rejects an autonomous invocation when plan/task/invocation scope drifts", () => {
    expect(() => bindAutonomousCapabilityInvocation({
      requestScope: scope,
      planScope: {
        portfolioId: "portfolio-b",
        companyId: scope.companyId,
        environment: scope.environment
      },
      taskScope: scope,
      scope,
      capability: "repository.inspect",
      parameters: { repository: "DMART19/GetDone" },
      correlationId: "correlation-6",
      idempotencyKey: "idem-autonomous-6"
    })).toThrow();

    const bound = bindAutonomousCapabilityInvocation({
      requestScope: scope,
      planScope: {
        portfolioId: scope.portfolioId,
        companyId: scope.companyId,
        environment: scope.environment
      },
      taskScope: scope,
      scope,
      capability: "repository.inspect",
      parameters: { repository: "DMART19/GetDone" },
      correlationId: "correlation-7",
      idempotencyKey: "idem-autonomous-7"
    });
    expect(bound.input).toMatchObject({ companyId: "company-a" });
  });
});
