import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { KillSwitch } from "@/lib/domain/kill-switch";
import { admitAIBudget, estimateProfileRequestCostCents } from "@/lib/ai-gateway/budget";
import {
  actualResponseCostCents,
  createAICallAuditRecord,
  createAIUsageRecord
} from "@/lib/ai-gateway/audit";
import {
  assertRouteDecisionIntegrity,
  routeAIRequest
} from "@/lib/ai-gateway/router";
import type {
  AIBudgetSnapshot,
  AIAdapterResponse,
  AICallAuditStore,
  AIGatewayAdapter,
  AIInvocationFailureReason,
  AIInvocationResult,
  AIOutputSchema,
  AIRequestEnvelope,
  ModelProfile,
  ModelRoutePolicy
} from "@/lib/ai-gateway/contracts";

export class AIGateway {
  private readonly adapters: ReadonlyMap<string, AIGatewayAdapter>;
  private readonly singleAdapter?: AIGatewayAdapter;

  constructor(
    private readonly profiles: readonly ModelProfile[],
    private readonly policy: ModelRoutePolicy,
    adapters?: AIGatewayAdapter | readonly AIGatewayAdapter[],
    private readonly auditStore?: AICallAuditStore
  ) {
    const values = !adapters ? [] : Array.isArray(adapters) ? adapters : [adapters];
    this.adapters = new Map(values.map((adapter) => [adapter.id, adapter]));
    this.singleAdapter = values.length === 1 ? values[0] : undefined;
  }

  private async finish<T extends AIInvocationResult<unknown>>(result: T): Promise<T> {
    if (this.auditStore) await this.auditStore.appendAudit(result.audit);
    return result;
  }

  private async usage(record: Parameters<AICallAuditStore["appendUsage"]>[0]) {
    if (this.auditStore) await this.auditStore.appendUsage(record);
  }

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
      return this.finish({
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
      });
    }

    const byId = new Map(this.profiles.map((profile) => [profile.id, profile]));
    const attempts = [route.selectedProfileId, ...route.fallbackProfileIds];
    let lastFailure: Exclude<AIInvocationFailureReason, "NO_ELIGIBLE_MODEL"> = "MODEL_CALL_FAILED";
    let actualTotalCostCents = 0;
    let estimatedTotalCostCents = 0;

    for (let index = 0; index < attempts.length; index += 1) {
      const profileId = attempts[index]!;
      const profile = byId.get(profileId);
      if (!profile) continue;
      const adapter = this.adapters.get(profile.gatewayId) ?? this.singleAdapter;
      if (!adapter) {
        lastFailure = "ADAPTER_UNAVAILABLE";
        await this.usage(createAIUsageRecord({
          request: input.request,
          profile,
          attempt: index + 1,
          estimatedCostCents: 0,
          recordedAt: now,
          outcome: "failed",
          failureClass: "ADAPTER_UNAVAILABLE"
        }));
        if (!input.request.requirements.allowFallback) break;
        continue;
      }

      admitAIBudget({ request: input.request, profile, snapshot: input.budget, admittedAt: now });
      const estimatedCostCents = estimateProfileRequestCostCents(profile, input.request);
      estimatedTotalCostCents = Number((estimatedTotalCostCents + estimatedCostCents).toFixed(6));
      let response: AIAdapterResponse;
      try {
        response = await adapter.invoke({
          requestId: input.request.id,
          correlationId: input.request.correlationId,
          profile,
          input: input.payload,
          requirements: input.request.requirements
        });
      } catch {
        lastFailure = "MODEL_CALL_FAILED";
        await this.usage(createAIUsageRecord({
          request: input.request,
          profile,
          attempt: index + 1,
          estimatedCostCents,
          recordedAt: now,
          outcome: "failed",
          failureClass: lastFailure
        }));
        if (!input.request.requirements.allowFallback) break;
        continue;
      }

      actualTotalCostCents = Number((
        actualTotalCostCents + actualResponseCostCents(profile, response)
      ).toFixed(6));

      if (
        response.profileId !== profile.id
        || response.gatewayId !== profile.gatewayId
        || response.providerId !== profile.providerId
        || response.modelId !== profile.modelId
      ) {
        lastFailure = "MODEL_IDENTITY_MISMATCH";
        await this.usage(createAIUsageRecord({
          request: input.request,
          profile,
          attempt: index + 1,
          estimatedCostCents,
          recordedAt: now,
          response,
          outcome: "identity-mismatch",
          failureClass: lastFailure
        }));
        if (!input.request.requirements.allowFallback) break;
        continue;
      }

      const parsed = input.outputSchema.safeParse(response.output);
      if (!parsed.success) {
        lastFailure = "SCHEMA_INVALID";
        await this.usage(createAIUsageRecord({
          request: input.request,
          profile,
          attempt: index + 1,
          estimatedCostCents,
          recordedAt: now,
          response,
          outcome: "schema-invalid",
          failureClass: lastFailure
        }));
        if (!input.request.requirements.allowFallback) break;
        continue;
      }

      await this.usage(createAIUsageRecord({
        request: input.request,
        profile,
        attempt: index + 1,
        estimatedCostCents,
        recordedAt: now,
        response,
        outcome: "valid"
      }));
      return this.finish({
        kind: "success",
        output: parsed.data,
        route,
        audit: createAICallAuditRecord({
          request: input.request,
          route,
          response,
          estimatedCostCents: estimatedTotalCostCents,
          actualCostCents: actualTotalCostCents,
          recordedAt: now,
          fallbackUsed: index > 0,
          fallbackReason: index > 0 ? lastFailure : undefined,
          validationStatus: "valid"
        })
      });
    }

    return this.finish({
      kind: "unavailable",
      reason: lastFailure,
      route,
      audit: createAICallAuditRecord({
        request: input.request,
        route,
        estimatedCostCents: estimatedTotalCostCents,
        actualCostCents: actualTotalCostCents,
        recordedAt: now,
        validationStatus: "failed",
        failureClass: lastFailure
      })
    });
  }
}
