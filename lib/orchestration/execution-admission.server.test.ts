import { describe, expect, it } from "vitest";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  MvpBusinessActionExecutionAdmission,
  RoutedOrchestrationExecutionAdmission,
  type CapabilityExecutionAdmission
} from "@/lib/orchestration/execution-admission.server";

function route(
  supported: readonly string[],
  calls: string[]
): CapabilityExecutionAdmission {
  return {
    descriptor: {
      rereadsAuthoritativeJob: true,
      persistsExecutionSpec: true,
      durableQueue: true,
      providerExecutionSeparated: true
    },
    supports(capability) {
      return supported.includes(capability);
    },
    async admit(input) {
      calls.push(input.task.operations[input.operationIndex]!.capability);
    }
  };
}

const baseInput = {
  run: {
    id: "run-1",
    correlationId: "correlation-1",
    source: { type: "owner-intent" as const, id: "intent-1" },
    scope: {
      userId: "owner-a",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "staging" as const
    },
    authority: "coordination-only" as const,
    state: "jobs-enqueued" as const,
    version: 1,
    checkpoints: {
      decisionIds: [],
      authorizationGrants: [],
      tasks: [],
      jobIds: ["job-1"],
      verificationRequestIds: [],
      verifiedOutcomes: []
    },
    createdAt: "2026-09-28T16:00:00.000Z",
    updatedAt: "2026-09-28T16:00:00.000Z",
    recordHash: "a".repeat(64)
  },
  task: {
    id: "task-1",
    logicalKey: "logical-1",
    planId: "plan-1",
    planStepId: "step-1",
    scope: {
      userId: "owner-a",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "staging" as const,
      dataClass: "internal" as const
    },
    source: { type: "owner-request" as const, referenceId: "intent-1" },
    reason: "send email",
    evidenceIds: [],
    priority: "normal" as const,
    capabilityRequirements: ["email.send"],
    operations: [{
      capability: "email.send",
      input: {
        companyId: "company-a",
        to: ["owner@example.com"],
        subject: "subject",
        bodyText: "body"
      }
    }],
    authorizationLineage: [],
    authorizationGrantId: "grant-1",
    authorizationGrantHash: "b".repeat(64),
    authorizationConsumption: {
      id: "authorization-consumption:grant-1",
      grantId: "grant-1",
      grantHash: "b".repeat(64),
      consumerType: "task" as const,
      consumerId: "task-1",
      scope: {
        userId: "owner-a",
        portfolioId: "portfolio-a",
        companyId: "company-a",
        environment: "staging" as const
      },
      planHash: "c".repeat(64),
      stepHash: "d".repeat(64),
      consumedAt: "2026-09-28T16:00:00.000Z",
      consumptionHash: "e".repeat(64)
    },
    validationReceiptId: "receipt-1",
    validationReceiptHash: "f".repeat(64),
    policySnapshotId: "policy-1",
    policySnapshotHash: "1".repeat(64),
    dependsOnLogicalKeys: [],
    preconditions: [],
    resourceRequirements: {
      execution: {
        environment: "staging" as const,
        priority: 50,
        checkpointable: true,
        retryable: true
      },
      reliability: {
        minimumTier: "standard" as const,
        fallbackRequired: false,
        maxInterruptionClass: "brief" as const
      },
      data: {
        classification: "internal" as const,
        customerData: false,
        allowedRegions: ["us-west"]
      },
      economics: {},
      credentialBindingRequired: false
    },
    verificationRequirements: [{
      id: "verify-1",
      description: "verify",
      kind: "capability-output" as const,
      required: true
    }],
    rollback: {
      strategy: "none" as const,
      cancellationAllowed: true
    },
    estimatedCostCents: 0,
    createdAt: "2026-09-28T16:00:00.000Z"
  },
  grant: {} as never,
  operationIndex: 0,
  job: {} as never
};

describe("RoutedOrchestrationExecutionAdmission", () => {
  it("routes a capability to exactly one governed executor", async () => {
    const calls: string[] = [];
    const admission = new RoutedOrchestrationExecutionAdmission([
      route(["email.send"], calls),
      route(["repository.inspect"], calls)
    ]);
    await admission.admit(baseInput as never);
    expect(calls).toEqual(["email.send"]);
  });

  it("fails closed when no executor or multiple executors claim a capability", async () => {
    const calls: string[] = [];
    await expect(new RoutedOrchestrationExecutionAdmission([
      route(["repository.inspect"], calls)
    ]).admit(baseInput as never)).rejects.toBeInstanceOf(ControlPlaneError);

    await expect(new RoutedOrchestrationExecutionAdmission([
      route(["email.send"], calls),
      route(["email.send"], calls)
    ]).admit(baseInput as never)).rejects.toThrow(/ambiguous execution authority/i);
  });

  it("does not classify software capabilities as business actions", () => {
    const business = new MvpBusinessActionExecutionAdmission({
      enqueueAuthorizedBusinessAction: async () => ({ status: "enqueued" })
    } as never);
    expect(business.supports("email.send")).toBe(true);
    expect(business.supports("http.request")).toBe(true);
    expect(business.supports("repository.inspect")).toBe(false);
    expect(business.supports("production.deploy")).toBe(false);
  });
});
