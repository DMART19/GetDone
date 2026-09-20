import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { KillSwitch } from "@/lib/domain/kill-switch";
import { admitAIBudget, estimateProfileRequestCostCents } from "@/lib/ai-gateway/budget";
import { createAICallAuditRecord } from "@/lib/ai-gateway/audit";
import {
  assertRouteDecisionIntegrity,
  routeAIRequest
} from "@/lib/ai-gateway/router";
import type {
  AIBudgetSnapshot,
  AIGatewayAdapter,
  AIInvocationResult,
  AIOutputSchema,
  AIRequestEnvelope,
  ModelProfile,
  ModelRoutePolicy
} from "@/lib/ai-gateway/contracts";

export class AIGateway {
  constructor(
    private readonly profiles: readonly ModelProfile[],
    private readonly policy: ModelRoutePolicy,
    private readonly adapter?: AIGatewayAdapter
  ) {}

  plan(request: AIRequestEnvelope, killSwitches: readonly KillSwitch[] = [], decidedAt = new Date().toISOString()) {
    return routeAIRequest({
      request,
      profiles: this.profiles,
      policy: this.policy,
      killSwitches,
      decidedAt
    });
  }

  async invoke<T>(input: {
    request: AIRequestEnvelope;
    payload: unknown;
    outputSchema: AIOutputSchema<T>;
    budget: AIBudgetSnapshot;
    killSwitches?: readonly KillSwitch[];
    now?: string;
  }): Promise<AIInvocationResult<T>> {
    const now = input.now ?? new Date().toISOString();
    const route = this.plan(input.request, input.killSwitches ?? [], now);
    assertRouteDecisionIntegrity(route);

    if (route.kind === "deterministic") {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "DETERMINISTIC work must not invoke a model adapter",
        { details: { reason: "DETERMINISTIC_NO_MODEL_CALL" } }
      );
    }

    if (route.kind === "no-eligible-model" || !route.selectedProfileId) {
      return {
        kind: "unavailable",
        reason: "NO_ELIGIBLE_MODEL",
        route,
        audit: createAICallAuditRecord({
          request: input.request,
          route,
          estimatedCostCents: 0,
          recordedAt: now,
          validationStatus: "not-called",
          failureClass: "NO_ELIGIBLE_MODEL"
        })
      };
    }

    if (!this.adapter) {
      return {
        kind: "unavailable",
        reason: "ADAPTER_UNAVAILABLE",
        route,
        audit: createAICallAuditRecord({
          request: input.request,
          route,
          estimatedCostCents: 0,
          recordedAt: now,
          validationStatus: "not-called",
          failureClass: "ADAPTER_UNAVAILABLE"
        })
      };
    }

    const byId = new Map(this.profiles.map((profile) => [profile.id, profile]));
    const attempts = [route.selectedProfileId, ...route.fallbackProfileIds];
    let lastFailure = "MODEL_CALL_FAILED";

    for (let index = 0; index < attempts.length; index += 1) {
      const profileId = attempts[index]!;
      const profile = byId.get(profileId);
      if (!profile) continue;

      admitAIBudget({ request: input.request, profile, snapshot: input.budget, admittedAt: now });
      const estimatedCostCents = estimateProfileRequestCostCents(profile, input.request);
      try {
        const response = await this.adapter.invoke({
          requestId: input.request.id,
          correlationId: input.request.correlationId,
          profile,
          input: input.payload,
          requirements: input.request.requirements
        });

        if (
          response.profileId !== profile.id
          || response.gatewayId !== profile.gatewayId
          || response.providerId !== profile.providerId
          || response.modelId !== profile.modelId
        ) {
          lastFailure = "MODEL_IDENTITY_MISMATCH";
          continue;
        }

        const parsed = input.outputSchema.safeParse(response.output);
        if (!parsed.success) {
          lastFailure = "SCHEMA_INVALID";
          continue;
        }

        return {
          kind: "success",
          output: parsed.data,
          route,
          audit: createAICallAuditRecord({
            request: input.request,
            route,
            response,
            estimatedCostCents,
            recordedAt: now,
            fallbackUsed: index > 0,
            fallbackReason: index > 0 ? lastFailure : undefined,
            validationStatus: "valid"
          })
        };
      } catch (error) {
        lastFailure = error instanceof Error ? error.name || "MODEL_CALL_FAILED" : "MODEL_CALL_FAILED";
      }

      if (!input.request.requirements.allowFallback) break;
    }

    return {
      kind: "unavailable",
      reason: "ADAPTER_UNAVAILABLE",
      route,
      audit: createAICallAuditRecord({
        request: input.request,
        route,
        estimatedCostCents: 0,
        recordedAt: now,
        validationStatus: "failed",
        failureClass: lastFailure
      })
    };
  }
}
