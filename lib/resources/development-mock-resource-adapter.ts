import {
  createResourceAdapterEvidence,
  type ResourceAdapter,
  type ResourceAdapterContext
} from "@/lib/resources/adapter-sdk";

export class DevelopmentMockResourceAdapter implements ResourceAdapter {
  readonly id = "development-mock-resource-adapter";
  readonly version = "1.0.0";
  readonly providerId = "mock-provider";

  private evidence<T>(payload: T) {
    return createResourceAdapterEvidence({
      adapterId: this.id,
      adapterVersion: this.version,
      providerId: this.providerId,
      observedAt: "2026-09-20T22:00:00Z",
      payload
    });
  }

  async metadata(_context: ResourceAdapterContext) {
    return this.evidence({
      providerDisplayName: "Development Mock",
      providerType: "custom" as const,
      supportedEnvironments: ["development"] as const,
      mock: true
    });
  }
  async discover(_context: ResourceAdapterContext) {
    return this.evidence(["mock-resource-1"] as const);
  }
  async authenticate(_context: ResourceAdapterContext) {
    return this.evidence({ authenticated: true, bindingRef: "credential-binding:mock" });
  }
  async capabilities(_context: ResourceAdapterContext, _targetId: string) {
    return this.evidence(["compute.cpu.light", "storage.backup"] as const);
  }
  async health(_context: ResourceAdapterContext, _targetId: string) {
    return this.evidence({ status: "healthy" });
  }
  async capacity(_context: ResourceAdapterContext, _targetId: string) {
    return this.evidence({ cpu: 8, memoryMb: 16384 });
  }
  async cost(_context: ResourceAdapterContext, _targetId: string) {
    return this.evidence({ estimatedHourlyCents: 10, marginalHourlyCents: 10 });
  }
  async reserve(_context: ResourceAdapterContext, input: { targetId: string; reservationId: string; capacity: Readonly<Record<string, number>> }) {
    return this.evidence({ accepted: true, providerReservationRef: `provider-reservation:${input.reservationId}` });
  }
  async allocate(_context: ResourceAdapterContext, input: { targetId: string; allocationId: string; reservationId: string }) {
    return this.evidence({ accepted: true, providerAllocationRef: `provider-allocation:${input.allocationId}` });
  }
  async dispatch(_context: ResourceAdapterContext, input: { targetId: string; dispatchId: string; allocationId: string }) {
    return this.evidence({ accepted: true, providerOperationId: `provider-operation:${input.dispatchId}` });
  }
  async status(_context: ResourceAdapterContext, _input: { targetId: string; providerOperationId: string }) {
    return this.evidence({ state: "completed" as const });
  }
  async cancel(_context: ResourceAdapterContext, _input: { targetId: string; providerOperationId: string; reason: string }) {
    return this.evidence({ accepted: true });
  }
  async release(_context: ResourceAdapterContext, _input: { targetId: string; reservationId?: string; allocationId?: string }) {
    return this.evidence({ accepted: true });
  }
}
