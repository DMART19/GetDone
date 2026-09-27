import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { RequestContext } from "@/lib/control-plane/request-context";
import type {
  AIBudgetSnapshot,
  AIInvocationResult
} from "@/lib/ai-gateway/contracts";
import type { AIGateway } from "@/lib/ai-gateway/gateway";
import type { KillSwitch } from "@/lib/domain/kill-switch";
import { capabilityRegistry } from "@/lib/domain/capabilities";
import {
  constructPlanProposal,
  type AuthorizedPlanSource
} from "@/lib/planning/plan-construction";
import {
  PlanProposalSchema,
  type PlanProposal
} from "@/lib/planning/plan-schema";
import { hashPlan } from "@/lib/planning/plan-hash";
import type { OrchestrationRun } from "@/lib/orchestration/contracts";
import {
  assertContextSnapshotIntegrity,
  createGovernedPlanArtifact,
  planningArtifactId,
  type GovernedPlanArtifact,
  type OrchestrationContextSnapshot
} from "@/lib/orchestration/planning-artifacts";

export const GOVERNED_ORCHESTRATION_PLANNER_VERSION = "1.0.0";

export type PlannerAdmissionResult =
  | Readonly<{
      kind: "ready";
      budget: AIBudgetSnapshot;
      killSwitches: readonly KillSwitch[];
    }>
  | Readonly<{ kind: "unavailable"; reason: string; retryAt: string }>;

export interface GovernedPlannerAdmissionProvider {
  load(run: OrchestrationRun): Promise<PlannerAdmissionResult>;
}

export interface GovernedPlannerConfig {
  maxCostCents: number;
  expectedOutputTokens?: number;
  minimumContextTokens?: number;
  latencyClass?: "low" | "standard" | "high";
  allowFallback?: boolean;
}

export type GovernedPlanResult =
  | Readonly<{ kind: "ready"; artifact: GovernedPlanArtifact }>
  | Readonly<{ kind: "unavailable"; reason: string; retryAt: string }>;

function sourceForRun(run: OrchestrationRun): AuthorizedPlanSource {
  switch (run.source.kind) {
    case "owner-intent":
      return { type: "owner-request", referenceId: run.source.ownerIntentId };
    case "investigation":
      return { type: "investigation", referenceId: run.source.investigationId };
    case "objective":
      return { type: "objective", referenceId: run.source.objectiveId };
  }
}

function aiDataClass(value: OrchestrationContextSnapshot["dataClass"]) {
  switch (value) {
    case "public": return "PUBLIC" as const;
    case "internal": return "INTERNAL" as const;
    case "customer": return "CONFIDENTIAL" as const;
    case "sensitive": return "RESTRICTED" as const;
  }
}

function requestContext(run: OrchestrationRun): RequestContext {
  return Object.freeze({
    correlationId: run.correlationId,
    environment: run.environment,
    actor: run.initiatingActor,
    scope: Object.freeze({
      userId: run.authorityUserId,
      portfolioId: run.portfolioId,
      companyId: run.companyId
    })
  });
}

function plannerCapabilities() {
  return Object.freeze(
    capabilityRegistry
      .filter((capability) => capability.enabled)
      .map((capability) => Object.freeze({
        name: capability.name,
        description: capability.description,
        approval: capability.approval,
        risk: capability.risk,
        blastRadius: capability.blastRadius,
        productionEffect: capability.productionEffect,
        sensitivity: capability.sensitivity,
        reversible: capability.reversible
      }))
  );
}

function assertPlanGrounding(
  plan: PlanProposal,
  snapshot: OrchestrationContextSnapshot,
  run: OrchestrationRun
) {
  if (
    plan.scope.environment !== run.environment
    || plan.scope.dataClass !== snapshot.dataClass
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Governed planner output changed trusted environment or context data classification"
    );
  }

  const contextIds = new Set(snapshot.assembled.items.map((item) => item.id));
  for (const evidence of plan.evidence) {
    if (!contextIds.has(evidence.id)) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        `Plan cited evidence outside the persisted context snapshot: ${evidence.id}`
      );
    }
  }

  const planEvidenceIds = new Set(plan.evidence.map((evidence) => evidence.id));
  for (const step of plan.steps) {
    for (const evidenceId of step.evidenceIds) {
      if (!planEvidenceIds.has(evidenceId)) {
        throw new ControlPlaneError(
          "VALIDATION_FAILED",
          `Plan step ${step.id} references undeclared plan evidence ${evidenceId}`
        );
      }
    }
  }
}

export class AIGatewayGovernedPlanner {
  constructor(
    private readonly gateway: AIGateway,
    private readonly admission: GovernedPlannerAdmissionProvider,
    private readonly config: GovernedPlannerConfig,
    private readonly now: () => Date = () => new Date()
  ) {
    if (!Number.isFinite(config.maxCostCents) || config.maxCostCents <= 0) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Governed planner maxCostCents must be positive"
      );
    }
  }

  async propose(
    run: OrchestrationRun,
    context: OrchestrationContextSnapshot
  ): Promise<GovernedPlanResult> {
    assertContextSnapshotIntegrity(context);
    if (
      context.runId !== run.id
      || context.correlationId !== run.correlationId
      || context.portfolioId !== run.portfolioId
      || context.companyId !== run.companyId
      || context.environment !== run.environment
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Context snapshot does not belong to the orchestration run"
      );
    }

    const admission = await this.admission.load(run);
    if (admission.kind === "unavailable") return admission;

    const plannedAt = this.now().toISOString();
    const requestId = `orchestration-plan:${sha256Hex({
      runId: run.id,
      contextHash: context.contextHash,
      plannerVersion: GOVERNED_ORCHESTRATION_PLANNER_VERSION
    })}`;
    const payload = Object.freeze({
      instruction: [
        "Produce a GetDone PlanProposal only.",
        "Do not approve, authorize, enqueue, execute, or claim provider success.",
        "Use only the supplied persisted context evidence.",
        "Use only capability names from the supplied capability catalog.",
        "Preserve the exact portfolio, company, environment, source, and data class.",
        "Every step must include verification requirements and rollback semantics.",
        "If evidence is insufficient, make assumptions explicit rather than inventing facts."
      ].join(" "),
      authority: Object.freeze({
        portfolioId: run.portfolioId,
        companyId: run.companyId,
        environment: run.environment,
        dataClass: context.dataClass,
        source: sourceForRun(run)
      }),
      context: context.assembled,
      capabilityCatalog: plannerCapabilities()
    });

    const request = Object.freeze({
      id: requestId,
      correlationId: run.correlationId,
      scope: Object.freeze({
        userId: run.authorityUserId,
        portfolioId: run.portfolioId,
        companyId: run.companyId,
        environment: run.environment
      }),
      requirements: Object.freeze({
        role: "HIGH_REASONING" as const,
        requiredModalities: Object.freeze(["text"] as const),
        requiresTools: false,
        requiresStructuredOutput: true,
        minimumContextTokens: this.config.minimumContextTokens ?? 8_000,
        estimatedInputTokens: Math.max(
          1_000,
          Math.ceil(context.assembled.characterCount / 4) + 2_000
        ),
        expectedOutputTokens: this.config.expectedOutputTokens ?? 4_000,
        dataClass: aiDataClass(context.dataClass),
        environment: run.environment,
        latencyClass: this.config.latencyClass ?? "high",
        maxCostCents: this.config.maxCostCents,
        allowFallback: this.config.allowFallback ?? true
      }),
      inputHash: sha256Hex({
        plannerVersion: GOVERNED_ORCHESTRATION_PLANNER_VERSION,
        contextHash: context.contextHash,
        payload
      }),
      requestedAt: plannedAt
    });

    let result: AIInvocationResult<PlanProposal>;
    try {
      result = await this.gateway.invoke({
        request,
        payload,
        outputSchema: PlanProposalSchema,
        budget: admission.budget,
        killSwitches: admission.killSwitches,
        now: plannedAt
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "planner-invocation-failed";
      return Object.freeze({
        kind: "unavailable" as const,
        reason: reason.slice(0, 300),
        retryAt: new Date(this.now().getTime() + 60_000).toISOString()
      });
    }

    if (result.kind !== "success") {
      return Object.freeze({
        kind: "unavailable" as const,
        reason: `ai-planner-${result.reason.toLowerCase()}`,
        retryAt: new Date(this.now().getTime() + 60_000).toISOString()
      });
    }

    const plan = constructPlanProposal({
      candidate: result.output,
      request: requestContext(run),
      authorizedSource: sourceForRun(run)
    });
    assertPlanGrounding(plan, context, run);

    const artifact = createGovernedPlanArtifact({
      id: planningArtifactId({
        kind: "plan-proposal",
        runId: run.id,
        predecessorHash: context.contextHash
      }),
      runId: run.id,
      correlationId: run.correlationId,
      contextSnapshotId: context.id,
      contextHash: context.contextHash,
      plan,
      planHash: hashPlan(plan),
      aiAudit: result.audit,
      route: result.route,
      plannedAt
    });

    return Object.freeze({ kind: "ready" as const, artifact });
  }
}
