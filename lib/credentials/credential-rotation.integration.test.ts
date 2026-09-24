import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  createCredentialBinding,
  createCredentialRequest,
  createSecretReference,
  issueCredentialLease,
  type CredentialLease,
  type CredentialUsageAudit
} from "@/lib/credentials/broker";
import {
  CREDENTIAL_ROTATION_MATRIX,
  credentialRotationDecision,
  type RotationProvider
} from "@/lib/credentials/rotation-policy";
import {
  GovernedBusinessActionCredentialBroker,
  type CredentialDeliveryProvider
} from "@/lib/credentials/runtime-broker";
import type {
  AuthorizedBusinessActionRequest,
  BusinessActionAdapter,
  BusinessActionExecutionContext
} from "@/lib/execution/adapters/business-action";
import {
  createBusinessActionAdapterResult,
  createBusinessActionStatus
} from "@/lib/execution/adapters/business-action";
import {
  BusinessActionExecutionOrchestrator,
  type BusinessActionExecutionRecord
} from "@/lib/execution/business-action-orchestrator";
import {
  OpenRouterAIGatewayAdapter,
  type OpenRouterCredentialProvider
} from "@/lib/ai-gateway/openrouter-adapter";

const now = new Date("2026-09-24T12:00:00.000Z");

const scope = Object.freeze({
  userId: "owner",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "staging" as const,
  resourceId: "resource-a"
});

class MemoryCredentialStore {
  audits: CredentialUsageAudit[] = [];
  constructor(readonly lease: CredentialLease) {}
  async get(id: string) { return id === this.lease.id ? this.lease : null; }
  async append(record: CredentialUsageAudit) { this.audits.push(record); }
}

class RotatingDelivery implements CredentialDeliveryProvider {
  version = 1;
  material = "credential-v1";
  async redeem(input: Parameters<CredentialDeliveryProvider["redeem"]>[0]) {
    return {
      material: this.material,
      expiresAt: input.lease.expiresAt,
      providerId: input.lease.providerId,
      credentialVersion: this.version,
      grantedScopes: [...input.requiredScopes]
    };
  }
  rotate(version: number) {
    this.version = version;
    this.material = "credential-v" + version;
  }
}

function leaseFor(providerId: string, capability: string) {
  const secret = createSecretReference({
    id: "secret-" + providerId,
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    providerId,
    environment: scope.environment,
    purpose: "rotation acceptance",
    backendRef: "vault://" + providerId,
    status: "active",
    rotationVersion: 1
  });
  const binding = createCredentialBinding({
    id: "binding-" + providerId,
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    providerId,
    environment: scope.environment,
    secretReferenceId: secret.id,
    capabilityNames: [capability],
    grantedScopes: ["operate"],
    allowedResourceIds: [scope.resourceId],
    allowedLocationClasses: ["cloud"],
    status: "active"
  });
  const request = createCredentialRequest({
    id: "credential-request-" + providerId,
    jobId: "job-" + providerId,
    placementRequestId: "placement-" + providerId,
    scope,
    resourceId: scope.resourceId,
    resourceState: "ready",
    resourceLocationClass: "cloud",
    providerId,
    capability,
    requestedScopes: ["operate"],
    requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString()
  });
  return issueCredentialLease({
    leaseId: "lease-" + providerId,
    request,
    secret,
    binding,
    deliveryRef: "delivery://" + providerId,
    issuedAt: now.toISOString(),
    ttlSeconds: 3_600
  });
}

function action(providerId: string, capability: string): AuthorizedBusinessActionRequest {
  const input = { providerId };
  return Object.freeze({
    id: "action-" + providerId,
    jobId: "job-" + providerId,
    scope,
    capability,
    input,
    inputHash: sha256Hex(input),
    authorizationConsumptionHash: "consumption-" + providerId,
    credentialLeaseId: "lease-" + providerId,
    idempotencyKey: "idempotency-" + providerId,
    timeoutMs: 5_000,
    attempt: 1
  });
}

class MemoryExecutionStore {
  record: BusinessActionExecutionRecord | null = null;
  async get() { return this.record; }
  async save(record: BusinessActionExecutionRecord, expectedRecordHash?: string) {
    if (this.record && expectedRecordHash !== this.record.recordHash) {
      throw new Error("record hash mismatch");
    }
    this.record = record;
  }
}

class RotationAdapter implements BusinessActionAdapter {
  readonly version = "1.0.0";
  executeVersions: number[] = [];
  statusVersions: number[] = [];
  statusState: "pending" | "completed" = "pending";

  constructor(
    readonly id: string,
    private readonly providerId: string
  ) {}

  credentialRequirement() {
    return { providerId: this.providerId, requiredScopes: ["operate"] };
  }

  async execute(request: AuthorizedBusinessActionRequest, context?: BusinessActionExecutionContext) {
    this.executeVersions.push(context?.credential?.credentialVersion ?? -1);
    return createBusinessActionAdapterResult({
      source: "business-action-adapter",
      requestId: request.id,
      adapterId: this.id,
      adapterVersion: this.version,
      status: "accepted",
      providerOperationId: this.id + ":provider-operation-1",
      retryable: false,
      retryClass: "none",
      observedAt: now.toISOString()
    });
  }

  async status(
    input: { requestId: string; providerOperationId: string },
    context?: BusinessActionExecutionContext
  ) {
    this.statusVersions.push(context?.credential?.credentialVersion ?? -1);
    return createBusinessActionStatus({
      source: "business-action-adapter",
      requestId: input.requestId,
      providerOperationId: input.providerOperationId,
      adapterId: this.id,
      adapterVersion: this.version,
      state: this.statusState,
      observedAt: now.toISOString()
    });
  }
}

const providerCases = [
  ["gmail", "gmail", "email.send"],
  ["slack", "slack", "slack.message.send"],
  ["configured-https", "configured-https", "http.request"],
  ["webhook", "webhook", "webhook.send"]
] as const;

describe("credential rotation resume policy", () => {
  it("defines every provider/state decision explicitly", () => {
    expect(CREDENTIAL_ROTATION_MATRIX).toHaveLength(20);
    for (const provider of ["gmail", "slack", "configured-https", "webhook"] as const) {
      for (const phase of ["queued", "claimed", "accepted", "verification-pending"] as const) {
        const decision = credentialRotationDecision(provider, phase);
        expect(decision.selection).toBe("latest-active");
        expect(decision.preservesProviderOperationId)
          .toBe(phase === "accepted" || phase === "verification-pending");
      }
    }
    expect(credentialRotationDecision("openrouter", "queued").selection).toBe("latest-active");
    expect(credentialRotationDecision("openrouter", "claimed").selection).toBe("latest-active");
    expect(credentialRotationDecision("openrouter", "accepted").selection).toBe("not-applicable");
    expect(credentialRotationDecision("openrouter", "verification-pending").selection)
      .toBe("not-applicable");
  });

  for (const [label, providerId, capability] of providerCases) {
    it(label + " uses latest active credential while preserving accepted operation identity", async () => {
      const lease = leaseFor(providerId, capability);
      const credentialStore = new MemoryCredentialStore(lease);
      const delivery = new RotatingDelivery();
      const broker = new GovernedBusinessActionCredentialBroker(
        credentialStore,
        credentialStore,
        delivery,
        () => now
      );
      const adapter = new RotationAdapter(label, providerId);
      const executions = new MemoryExecutionStore();
      const request = action(providerId, capability);

      delivery.rotate(2); // Rotation while queued/claimed, before the first provider call.
      const first = new BusinessActionExecutionOrchestrator(
        { resolve: async () => adapter },
        executions,
        { credentialBroker: broker, maxStatusPolls: 0, now: () => now }
      );
      const accepted = await first.execute(request);
      expect(accepted.record.state).toBe("accepted");
      expect(adapter.executeVersions).toEqual([2]);
      const providerOperationId = accepted.record.providerOperationId;

      delivery.rotate(3); // Rotation after provider acceptance.
      adapter.statusState = "pending";
      const verificationPending = new BusinessActionExecutionOrchestrator(
        { resolve: async () => adapter },
        executions,
        { credentialBroker: broker, maxStatusPolls: 1, now: () => now }
      );
      const pending = await verificationPending.execute(request);
      expect(pending.record.state).toBe("pending");
      expect(pending.record.providerOperationId).toBe(providerOperationId);
      expect(adapter.statusVersions.at(-1)).toBe(3);

      delivery.rotate(4); // Rotation while verification is pending.
      adapter.statusState = "completed";
      const resumed = await verificationPending.execute(request);
      expect(resumed.record.state).toBe("completed");
      expect(resumed.record.providerOperationId).toBe(providerOperationId);
      expect(adapter.statusVersions.at(-1)).toBe(4);

      expect(credentialStore.audits.map((audit) => audit.credentialVersion))
        .toEqual([2, 3, 4]);
      expect(lease.issuedCredentialVersion).toBe(1);
    });
  }

  it("OpenRouter resolves the current credential again on a retry after rotation", async () => {
    const seenAuthorization: string[] = [];
    const credential: OpenRouterCredentialProvider & { rotate(version: number): void } = {
      version: 1,
      async current(this: { version: number }) {
        return { material: "openrouter-v" + this.version, version: this.version };
      },
      rotate(this: { version: number }, version: number) {
        this.version = version;
      }
    } as OpenRouterCredentialProvider & { version: number; rotate(version: number): void };

    let calls = 0;
    const adapter = new OpenRouterAIGatewayAdapter({
      apiKey: "fallback-fixture",
      maxRetries: 1,
      retryBaseDelayMs: 0
    }, {
      credentialProvider: credential,
      sleep: async () => {},
      fetchImpl: async (_url, init) => {
        calls += 1;
        const headers = init?.headers as Record<string, string>;
        seenAuthorization.push(headers.authorization);
        if (calls === 1) {
          credential.rotate(2);
          return new Response('{"error":"rate limited"}', { status: 429 });
        }
        return new Response(JSON.stringify({
          model: "openai/gpt-5.6",
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 2, completion_tokens: 1 }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });

    const response = await adapter.invoke({
      requestId: "request-1",
      correlationId: "correlation-1",
      profile: {
        id: "profile-1",
        gatewayId: "openrouter",
        providerId: "openrouter",
        modelId: "openai/gpt-5.6",
        enabled: true,
        validationStatus: "validated",
        roles: ["STANDARD"],
        modalities: ["text"],
        supportsTools: false,
        supportsStructuredOutput: true,
        maxContextTokens: 128_000,
        allowedDataClasses: ["PUBLIC"],
        allowedEnvironments: ["staging"],
        health: "healthy",
        latencyClass: "standard",
        inputCostPerMillionTokensCents: 100,
        outputCostPerMillionTokensCents: 100,
        profileVersion: "1.0.0"
      },
      input: "hello",
      requirements: {
        role: "STANDARD",
        requiredModalities: ["text"],
        requiresTools: false,
        requiresStructuredOutput: false,
        minimumContextTokens: 1_000,
        estimatedInputTokens: 10,
        expectedOutputTokens: 10,
        dataClass: "PUBLIC",
        environment: "staging",
        latencyClass: "standard",
        maxCostCents: 10,
        allowFallback: false
      }
    });

    expect(response.output).toBe("ok");
    expect(seenAuthorization).toEqual(["Bearer openrouter-v1", "Bearer openrouter-v2"]);
  });
});
