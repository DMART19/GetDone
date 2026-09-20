import type { PlanProposal } from "@/lib/planning/plan-schema";

export function validPlan(overrides: Partial<PlanProposal> = {}): PlanProposal {
  const base: PlanProposal = {
    id: "plan-1",
    proposalVersion: 1,
    scope: {
      portfolioId: "portfolio-a",
      companyId: "company-a",
      environment: "staging",
      dataClass: "internal"
    },
    source: {
      type: "objective",
      objectiveId: "objective-1"
    },
    objective: {
      id: "objective-1",
      metric: "release-readiness",
      target: 1
    },
    evidence: [{
      id: "evidence-1",
      kind: "fact",
      source: "repository",
      observedAt: "2026-09-20T16:00:00Z"
    }],
    assumptions: ["Repository access remains read-only during inspection"],
    planDependencies: [],
    requestedCapabilities: ["repository.inspect"],
    expectedOutcomes: [{
      metric: "inspection-complete",
      target: 1,
      description: "Repository inspection completes with a validated result"
    }],
    estimatedCostCents: 20,
    risk: {
      level: "low",
      summary: "Read-only inspection",
      blastRadius: "single-object"
    },
    rollback: {
      strategy: "none",
      cancellationAllowed: true
    },
    verificationRequirements: [{
      id: "verify-plan-1",
      description: "Inspection result validates against the capability output schema",
      kind: "capability-output",
      required: true
    }],
    steps: [{
      id: "step-1",
      title: "Inspect repository",
      reason: "Collect deterministic repository evidence",
      evidenceIds: ["evidence-1"],
      dependsOn: [],
      conflictsWith: [],
      capabilityRequests: [{
        capability: "repository.inspect",
        input: {
          companyId: "company-a",
          repository: "DMART19/GetDone",
          ref: "main"
        }
      }],
      preconditions: [{
        key: "repository.connected",
        operator: "equals",
        expected: true
      }],
      effects: [{
        key: "repository.inspected",
        operation: "set",
        value: true
      }],
      expectedOutcome: "Repository metadata and file inventory are available",
      estimatedCostCents: 20,
      risk: {
        level: "low",
        summary: "Read-only repository operation",
        blastRadius: "single-object"
      },
      rollback: {
        strategy: "none",
        cancellationAllowed: true
      },
      verificationRequirements: [{
        id: "verify-step-1",
        description: "Validate inspection output",
        kind: "capability-output",
        required: true
      }],
      resourceRequirements: {
        execution: {
          environment: "staging",
          priority: 50,
          checkpointable: true,
          retryable: true
        },
        reliability: {
          minimumTier: "standard",
          fallbackRequired: false,
          maxInterruptionClass: "brief"
        },
        data: {
          classification: "internal",
          customerData: false,
          allowedRegions: ["us-west"]
        },
        economics: {
          maxJobCostCents: 20
        },
        credentialBindingRequired: false
      }
    }],
    createdAt: "2026-09-20T16:00:00Z"
  };

  return {
    ...base,
    ...overrides
  };
}
