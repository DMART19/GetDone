import {
  createResourceAdapterEvidence,
  type ResourceAdapter,
  type ResourceAdapterContext
} from "@/lib/resources/adapter-sdk";

export class DevelopmentMockResourceAdapter implements ResourceAdapter {
  readonly id = "development-mock-resource-adapter";
  readonly version = "1.1.0";
  readonly providerId = "mock-provider";
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date("2026-09-20T22:00:00Z")) {
    this.now = now;
  }

  private assertContext(context: ResourceAdapterContext) {
    if (
      context.providerId !== this.providerId
      || context.scope.environment !== "development"
    ) {
      throw new Error(
        "Development mock Resource Adapter is DEVELOPMENT-only and requires mock-provider context"
      );
    }
  }

  private evidence<T>(context: ResourceAdapterContext, payload: T) {
    return createResourceAdapterEvidence({
      adapterId: this.id,
      adapterVersion: this.version,
      context,
      observedAt: this.now().toISOString(),
      payload
    });
  }

  async metadata(context: ResourceAdapterContext) {
    this.assertContext(context);
    return this.evidence(context, {
      providerDisplayName: "Development Mock",
      providerType: "custom" as const,
      supportedEnvironments: ["development"] as const,
      mock: true
    });
  }

  async discover(context: ResourceAdapterContext) {
    this.assertContext(context);
    return this.evidence(context, ["mock-resource-1"] as const);
  }

  async authenticate(context: ResourceAdapterContext) {
    this.assertContext(context);
    return this.evidence(context, {
      authenticated: true,
      bindingRef: "credential-binding:mock"
    });
  }

  async capabilities(context: ResourceAdapterContext, targetId: string) {
    this.assertContext(context);
    if (!targetId) throw new Error("targetId is required");
    return this.evidence(context, ["compute.cpu.light", "storage.backup"] as const);
  }

  async health(context: ResourceAdapterContext, targetId: string) {
    this.assertContext(context);
    if (!targetId) throw new Error("targetId is required");
    return this.evidence(context, { status: "healthy" });
  }

  async capacity(context: ResourceAdapterContext, targetId: string) {
    this.assertContext(context);
    if (!targetId) throw new Error("targetId is required");
    return this.evidence(context, { cpu: 8, memoryMb: 16384 });
  }

  async cost(context: ResourceAdapterContext, targetId: string) {
    this.assertContext(context);
    if (!targetId) throw new Error("targetId is required");
    return this.evidence(context, {
      estimatedHourlyCents: 10,
      marginalHourlyCents: 10
    });
  }

  async reserve(
    context: ResourceAdapterContext,
    input: {
      targetId: string;
      reservationId: string;
      capacity: Readonly<Record<string, number>>;
    }
  ) {
    this.assertContext(context);
    if (!input.targetId || !input.reservationId) throw new Error("reserve identity is required");
    return this.evidence(context, {
      accepted: true,
      providerReservationRef: `provider-reservation:${input.reservationId}`
    });
  }

  async allocate(
    context: ResourceAdapterContext,
    input: {
      targetId: string;
      allocationId: string;
      reservationId: string;
    }
  ) {
    this.assertContext(context);
    if (!input.targetId || !input.allocationId || !input.reservationId) {
      throw new Error("allocate lineage is required");
    }
    return this.evidence(context, {
      accepted: true,
      providerAllocationRef: `provider-allocation:${input.allocationId}`
    });
  }

  async dispatch(
    context: ResourceAdapterContext,
    input: {
      targetId: string;
      dispatchId: string;
      allocationId: string;
    }
  ) {
    this.assertContext(context);
    if (!input.targetId || !input.dispatchId || !input.allocationId) {
      throw new Error("dispatch lineage is required");
    }
    return this.evidence(context, {
      accepted: true,
      providerOperationId: `provider-operation:${input.dispatchId}`
    });
  }

  async status(
    context: ResourceAdapterContext,
    input: { targetId: string; providerOperationId: string }
  ) {
    this.assertContext(context);
    if (!input.targetId || !input.providerOperationId) throw new Error("status lineage is required");
    return this.evidence(context, { state: "completed" as const });
  }

  async cancel(
    context: ResourceAdapterContext,
    input: { targetId: string; providerOperationId: string; reason: string }
  ) {
    this.assertContext(context);
    if (!input.targetId || !input.providerOperationId || !input.reason.trim()) {
      throw new Error("cancel lineage and reason are required");
    }
    return this.evidence(context, { accepted: true });
  }

  async release(
    context: ResourceAdapterContext,
    input: {
      targetId: string;
      reservationId?: string;
      allocationId?: string;
    }
  ) {
    this.assertContext(context);
    if (!input.targetId || (!input.reservationId && !input.allocationId)) {
      throw new Error("release target and reservation/allocation lineage are required");
    }
    return this.evidence(context, { accepted: true });
  }
}
