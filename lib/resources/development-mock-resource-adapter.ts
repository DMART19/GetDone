import {
  createResourceAdapterEvidence,
  type ResourceAdapter,
  type ResourceAdapterContext
} from "@/lib/resources/adapter-sdk";

export class DevelopmentMockResourceAdapter implements ResourceAdapter {
  readonly id = "development-mock-resource-adapter";
  readonly version = "1.0.0";
  readonly providerId = "mock-provider";

  private assertContext(context: ResourceAdapterContext) {
    if (
      context.providerId !== this.providerId
      || context.scope.environment !== "development"
    ) {
      throw new Error("Development mock Resource Adapter requires DEVELOPMENT mock-provider context");
    }
  }

  private evidence<T>(payload: T) {
    return createResourceAdapterEvidence({
      adapterId: this.id,
      adapterVersion: this.version,
      providerId: this.providerId,
      observedAt: "2026-09-20T22:00:00Z",
      payload
    });
  }

  async metadata(context: ResourceAdapterContext) {
    this.assertContext(context);
    return this.evidence({
      providerDisplayName: "Development Mock",
      providerType: "custom" as const,
      supportedEnvironments: ["development"] as const,
      mock: true
    });
  }
  async discover(context: ResourceAdapterContext) {
    this.assertContext(context);
    return this.evidence(["mock-resource-1"] as const);
  }
  async authenticate(context: ResourceAdapterContext) {
    this.assertContext(context);
    return this.evidence({ authenticated: true, bindingRef: "credential-binding:mock" });
  }
  async capabilities(context: ResourceAdapterContext, targetId: string) {
    this.assertContext(context);
    void targetId;
    return this.evidence(["compute.cpu.light", "storage.backup"] as const);
  }
  async health(context: ResourceAdapterContext, targetId: string) {
    this.assertContext(context);
    void targetId;
    return this.evidence({ status: "healthy" });
  }
  async capacity(context: ResourceAdapterContext, targetId: string) {
    this.assertContext(context);
    void targetId;
    return this.evidence({ cpu: 8, memoryMb: 16384 });
  }
  async cost(context: ResourceAdapterContext, targetId: string) {
    this.assertContext(context);
    void targetId;
    return this.evidence({ estimatedHourlyCents: 10, marginalHourlyCents: 10 });
  }
  async reserve(context: ResourceAdapterContext, input: {
    this.assertContext(context); targetId: string; reservationId: string; capacity: Readonly<Record<string, number>> }) {
    return this.evidence({ accepted: true, providerReservationRef: `provider-reservation:${input.reservationId}` });
  }
  async allocate(context: ResourceAdapterContext, input: {
    this.assertContext(context); targetId: string; allocationId: string; reservationId: string }) {
    return this.evidence({ accepted: true, providerAllocationRef: `provider-allocation:${input.allocationId}` });
  }
  async dispatch(context: ResourceAdapterContext, input: {
    this.assertContext(context); targetId: string; dispatchId: string; allocationId: string }) {
    return this.evidence({ accepted: true, providerOperationId: `provider-operation:${input.dispatchId}` });
  }
  async status(context: ResourceAdapterContext, input: {
    this.assertContext(context);
    void input; targetId: string; providerOperationId: string }) {
    return this.evidence({ state: "completed" as const });
  }
  async cancel(context: ResourceAdapterContext, input: {
    this.assertContext(context);
    void input; targetId: string; providerOperationId: string; reason: string }) {
    return this.evidence({ accepted: true });
  }
  async release(context: ResourceAdapterContext, input: {
    this.assertContext(context);
    void input; targetId: string; reservationId?: string; allocationId?: string }) {
    return this.evidence({ accepted: true });
  }
}
