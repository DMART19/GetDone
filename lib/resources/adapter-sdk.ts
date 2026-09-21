import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export const RESOURCE_ADAPTER_SDK_CONTRACT_VERSION = "1.1.0";

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
  scope: ResourceAdapterContext["scope"];
  correlationId: string;
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

function normalizeContext(context: ResourceAdapterContext) {
  if (
    !context.scope.portfolioId
    || !context.scope.companyId
    || !context.correlationId
    || !context.providerId
  ) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Resource adapter context identity is required");
  }
  return Object.freeze({
    scope: Object.freeze({ ...context.scope }),
    correlationId: context.correlationId,
    providerId: context.providerId
  });
}

export function createResourceAdapterEvidence<T>(input: {
  adapterId: string;
  adapterVersion: string;
  context: ResourceAdapterContext;
  observedAt: string;
  payload: T;
}): ResourceAdapterEvidence<T> {
  if (!input.adapterId || !input.adapterVersion) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Resource adapter evidence identity is required");
  }
  const context = normalizeContext(input.context);
  const observedAt = Date.parse(input.observedAt);
  if (!Number.isFinite(observedAt)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Resource adapter observedAt is invalid");
  }
  const base = {
    source: "resource-adapter" as const,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    providerId: context.providerId,
    scope: context.scope,
    correlationId: context.correlationId,
    observedAt: new Date(observedAt).toISOString(),
    authoritative: false as const,
    payload: input.payload
  };
  return Object.freeze({ ...base, evidenceHash: sha256Hex(base) });
}

export function assertResourceAdapterEvidence<T>(
  evidence: ResourceAdapterEvidence<T>,
  adapter: Pick<ResourceAdapter, "id" | "version" | "providerId">,
  context?: ResourceAdapterContext
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
  if (
    context
    && (
      evidence.providerId !== context.providerId
      || evidence.correlationId !== context.correlationId
      || evidence.scope.portfolioId !== context.scope.portfolioId
      || evidence.scope.companyId !== context.scope.companyId
      || evidence.scope.environment !== context.scope.environment
    )
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Resource adapter evidence is outside the requested tenant/environment/correlation scope"
    );
  }
  return evidence;
}

function assertNonNegativeVector(vector: Readonly<Record<string, number>>, label: string) {
  for (const [key, value] of Object.entries(vector)) {
    if (!key || !Number.isFinite(value) || value < 0) {
      throw new ControlPlaneError("VALIDATION_FAILED", `${label} contains invalid capacity`);
    }
  }
}

function assertNonNegativeOptional(value: number | undefined, label: string) {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be non-negative`);
  }
}

export async function assertResourceAdapterConformance(input: {
  adapter: ResourceAdapter;
  context: ResourceAdapterContext;
  fixtureTargetId: string;
  fixtureCapacity?: Readonly<Record<string, number>>;
}) {
  const { adapter, context, fixtureTargetId } = input;
  normalizeContext(context);
  if (context.providerId !== adapter.providerId) {
    throw new ControlPlaneError("FORBIDDEN", "Resource adapter provider/context mismatch");
  }
  if (!fixtureTargetId) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Resource adapter conformance target is required");
  }

  const metadata = await adapter.metadata(context);
  const discovery = await adapter.discover(context);
  const authentication = await adapter.authenticate(context);
  const capabilities = await adapter.capabilities(context, fixtureTargetId);
  const health = await adapter.health(context, fixtureTargetId);
  const capacity = await adapter.capacity(context, fixtureTargetId);
  const cost = await adapter.cost(context, fixtureTargetId);

  for (const evidence of [
    metadata,
    discovery,
    authentication,
    capabilities,
    health,
    capacity,
    cost
  ]) {
    assertResourceAdapterEvidence(evidence, adapter, context);
  }

  if (metadata.payload.mock && context.scope.environment !== "development") {
    throw new ControlPlaneError("FORBIDDEN", "Mock Resource Adapter is DEVELOPMENT-only");
  }
  if (!metadata.payload.supportedEnvironments.includes(context.scope.environment)) {
    throw new ControlPlaneError("FORBIDDEN", "Resource Adapter does not support the requested environment");
  }
  if (!discovery.payload.includes(fixtureTargetId)) {
    throw new ControlPlaneError("FORBIDDEN", "Resource Adapter discovery did not include the conformance target");
  }
  if (!authentication.payload.authenticated) {
    throw new ControlPlaneError("FORBIDDEN", "Resource Adapter authentication did not establish provider access");
  }
  if (capabilities.payload.length === 0 || !health.payload.status) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Resource Adapter capability/health evidence is incomplete");
  }
  assertNonNegativeVector(capacity.payload, "Resource Adapter capacity");
  assertNonNegativeOptional(cost.payload.estimatedHourlyCents, "estimatedHourlyCents");
  assertNonNegativeOptional(cost.payload.marginalHourlyCents, "marginalHourlyCents");

  const fixtureCapacity = input.fixtureCapacity ?? { cpu: 1 };
  assertNonNegativeVector(fixtureCapacity, "Resource Adapter conformance fixture capacity");
  const reservationId = `conformance:${context.correlationId}:reservation`;
  const allocationId = `conformance:${context.correlationId}:allocation`;
  const dispatchId = `conformance:${context.correlationId}:dispatch`;

  const reservation = await adapter.reserve(context, {
    targetId: fixtureTargetId,
    reservationId,
    capacity: fixtureCapacity
  });
  assertResourceAdapterEvidence(reservation, adapter, context);
  if (!reservation.payload.accepted || !reservation.payload.providerReservationRef) {
    throw new ControlPlaneError("FORBIDDEN", "Resource Adapter reserve conformance failed");
  }

  const allocation = await adapter.allocate(context, {
    targetId: fixtureTargetId,
    allocationId,
    reservationId
  });
  assertResourceAdapterEvidence(allocation, adapter, context);
  if (!allocation.payload.accepted || !allocation.payload.providerAllocationRef) {
    throw new ControlPlaneError("FORBIDDEN", "Resource Adapter allocate conformance failed");
  }

  const dispatch = await adapter.dispatch(context, {
    targetId: fixtureTargetId,
    dispatchId,
    allocationId
  });
  assertResourceAdapterEvidence(dispatch, adapter, context);
  if (!dispatch.payload.accepted || !dispatch.payload.providerOperationId) {
    throw new ControlPlaneError("FORBIDDEN", "Resource Adapter dispatch conformance failed");
  }

  const status = await adapter.status(context, {
    targetId: fixtureTargetId,
    providerOperationId: dispatch.payload.providerOperationId
  });
  assertResourceAdapterEvidence(status, adapter, context);

  const cancellation = await adapter.cancel(context, {
    targetId: fixtureTargetId,
    providerOperationId: dispatch.payload.providerOperationId,
    reason: "conformance-cleanup"
  });
  assertResourceAdapterEvidence(cancellation, adapter, context);
  if (!cancellation.payload.accepted) {
    throw new ControlPlaneError("FORBIDDEN", "Resource Adapter cancel conformance failed");
  }

  const release = await adapter.release(context, {
    targetId: fixtureTargetId,
    reservationId,
    allocationId
  });
  assertResourceAdapterEvidence(release, adapter, context);
  if (!release.payload.accepted) {
    throw new ControlPlaneError("FORBIDDEN", "Resource Adapter release conformance failed");
  }

  const evidenceHashes = [
    metadata,
    discovery,
    authentication,
    capabilities,
    health,
    capacity,
    cost,
    reservation,
    allocation,
    dispatch,
    status,
    cancellation,
    release
  ].map((evidence) => evidence.evidenceHash);

  return Object.freeze({
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    providerId: adapter.providerId,
    conformancePassed: true as const,
    lifecycleExercised: true as const,
    authoritative: false as const,
    evidenceHashes: Object.freeze(evidenceHashes)
  });
}
