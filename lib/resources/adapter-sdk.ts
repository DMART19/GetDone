import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export const RESOURCE_ADAPTER_SDK_CONTRACT_VERSION = "1.0.0";

export interface ResourceAdapterContext {
  scope: Pick<TrustedExecutionScope, "portfolioId" | "companyId" | "environment">;
  correlationId: string;
  providerId: string;
}

export interface ResourceAdapterEvidence<T> {
  source: "resource-adapter";
  adapterId: string;
  adapterVersion: string;
  providerId: string;
  observedAt: string;
  authoritative: false;
  payload: T;
  evidenceHash: string;
}

export interface ResourceAdapterMetadata {
  providerDisplayName: string;
  providerType: "local" | "cloud" | "colo" | "partner" | "custom";
  supportedEnvironments: readonly TrustedExecutionScope["environment"][];
  mock: boolean;
}

export interface ResourceAdapter {
  readonly id: string;
  readonly version: string;
  readonly providerId: string;
  metadata(context: ResourceAdapterContext): Promise<ResourceAdapterEvidence<ResourceAdapterMetadata>>;
  discover(context: ResourceAdapterContext): Promise<ResourceAdapterEvidence<readonly string[]>>;
  authenticate(context: ResourceAdapterContext): Promise<ResourceAdapterEvidence<{ authenticated: boolean; bindingRef?: string }>>;
  capabilities(context: ResourceAdapterContext, targetId: string): Promise<ResourceAdapterEvidence<readonly string[]>>;
  health(context: ResourceAdapterContext, targetId: string): Promise<ResourceAdapterEvidence<{ status: string }>>;
  capacity(context: ResourceAdapterContext, targetId: string): Promise<ResourceAdapterEvidence<Readonly<Record<string, number>>>>;
  cost(context: ResourceAdapterContext, targetId: string): Promise<ResourceAdapterEvidence<{ estimatedHourlyCents?: number; marginalHourlyCents?: number }>>;
  reserve(context: ResourceAdapterContext, input: { targetId: string; reservationId: string; capacity: Readonly<Record<string, number>> }): Promise<ResourceAdapterEvidence<{ accepted: boolean; providerReservationRef?: string }>>;
  allocate(context: ResourceAdapterContext, input: { targetId: string; allocationId: string; reservationId: string }): Promise<ResourceAdapterEvidence<{ accepted: boolean; providerAllocationRef?: string }>>;
  dispatch(context: ResourceAdapterContext, input: { targetId: string; dispatchId: string; allocationId: string }): Promise<ResourceAdapterEvidence<{ accepted: boolean; providerOperationId?: string }>>;
  status(context: ResourceAdapterContext, input: { targetId: string; providerOperationId: string }): Promise<ResourceAdapterEvidence<{ state: "pending" | "running" | "completed" | "failed" | "cancelled" }>>;
  cancel(context: ResourceAdapterContext, input: { targetId: string; providerOperationId: string; reason: string }): Promise<ResourceAdapterEvidence<{ accepted: boolean }>>;
  release(context: ResourceAdapterContext, input: { targetId: string; reservationId?: string; allocationId?: string }): Promise<ResourceAdapterEvidence<{ accepted: boolean }>>;
}

export function createResourceAdapterEvidence<T>(input: {
  adapterId: string;
  adapterVersion: string;
  providerId: string;
  observedAt: string;
  payload: T;
}): ResourceAdapterEvidence<T> {
  if (!input.adapterId || !input.adapterVersion || !input.providerId) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Resource adapter evidence identity is required");
  }
  const observedAt = Date.parse(input.observedAt);
  if (!Number.isFinite(observedAt)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Resource adapter observedAt is invalid");
  }
  const base = {
    source: "resource-adapter" as const,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    providerId: input.providerId,
    observedAt: new Date(observedAt).toISOString(),
    authoritative: false as const,
    payload: input.payload
  };
  return Object.freeze({ ...base, evidenceHash: sha256Hex(base) });
}

export function assertResourceAdapterEvidence<T>(
  evidence: ResourceAdapterEvidence<T>,
  adapter: Pick<ResourceAdapter, "id" | "version" | "providerId">
) {
  const { evidenceHash, ...base } = evidence;
  if (
    sha256Hex(base) !== evidenceHash
    || evidence.source !== "resource-adapter"
    || evidence.authoritative !== false
    || evidence.adapterId !== adapter.id
    || evidence.adapterVersion !== adapter.version
    || evidence.providerId !== adapter.providerId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Resource adapter evidence is forged, mismatched, or claiming authority"
    );
  }
  return evidence;
}

export async function assertResourceAdapterConformance(input: {
  adapter: ResourceAdapter;
  context: ResourceAdapterContext;
  fixtureTargetId: string;
}) {
  const { adapter, context, fixtureTargetId } = input;
  if (context.providerId !== adapter.providerId) {
    throw new ControlPlaneError("FORBIDDEN", "Resource adapter provider/context mismatch");
  }
  const metadata = await adapter.metadata(context);
  const discovery = await adapter.discover(context);
  const authentication = await adapter.authenticate(context);
  const capabilities = await adapter.capabilities(context, fixtureTargetId);
  const health = await adapter.health(context, fixtureTargetId);
  const capacity = await adapter.capacity(context, fixtureTargetId);
  const cost = await adapter.cost(context, fixtureTargetId);

  assertResourceAdapterEvidence(metadata, adapter);
  assertResourceAdapterEvidence(discovery, adapter);
  assertResourceAdapterEvidence(authentication, adapter);
  assertResourceAdapterEvidence(capabilities, adapter);
  assertResourceAdapterEvidence(health, adapter);
  assertResourceAdapterEvidence(capacity, adapter);
  assertResourceAdapterEvidence(cost, adapter);
  if (
    metadata.payload.mock
    && context.scope.environment !== "development"
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Mock Resource Adapter is DEVELOPMENT-only");
  }
  if (!metadata.payload.supportedEnvironments.includes(context.scope.environment)) {
    throw new ControlPlaneError("FORBIDDEN", "Resource Adapter does not support the requested environment");
  }

  return Object.freeze({
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    providerId: adapter.providerId,
    conformancePassed: true as const,
    authoritative: false as const
  });
}
