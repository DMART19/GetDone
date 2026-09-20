import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export interface ProtectedCapacitySnapshot {
  id: string;
  portfolioId: string;
  companyId: string;
  resourceId?: string;
  poolId?: string;
  capacityClass: string;
  totalUnits: number;
  committedUnits: number;
  protectedMinimumFreeUnits: number;
  requestedUnits: number;
  freeAfterRequestUnits: number;
  headroomSatisfied: boolean;
  observedAt: string;
  expiresAt: string;
  snapshotHash: string;
}

export function createProtectedCapacitySnapshot(
  input: Omit<ProtectedCapacitySnapshot, "freeAfterRequestUnits" | "headroomSatisfied" | "snapshotHash">
): ProtectedCapacitySnapshot {
  const values = [
    input.totalUnits,
    input.committedUnits,
    input.protectedMinimumFreeUnits,
    input.requestedUnits
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Capacity values must be non-negative finite numbers");
  }

  const observedAt = Date.parse(input.observedAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt) || expiresAt <= observedAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Capacity snapshot has an invalid time window");
  }

  const freeAfterRequestUnits = input.totalUnits - input.committedUnits - input.requestedUnits;
  const headroomSatisfied = freeAfterRequestUnits >= input.protectedMinimumFreeUnits;
  const base = { ...input, freeAfterRequestUnits, headroomSatisfied };

  return Object.freeze({
    ...base,
    snapshotHash: sha256Hex(base)
  });
}

export function assertProtectedCapacitySnapshot(input: {
  snapshot: ProtectedCapacitySnapshot;
  scope: TrustedExecutionScope;
  resourceId?: string;
  poolId?: string;
  now?: number;
}) {
  const { snapshotHash, ...base } = input.snapshot;
  if (sha256Hex(base) !== snapshotHash) {
    throw new ControlPlaneError("FORBIDDEN", "Protected capacity snapshot integrity check failed");
  }
  const now = input.now ?? Date.now();
  if (
    input.snapshot.portfolioId !== input.scope.portfolioId
    || input.snapshot.companyId !== input.scope.companyId
    || (input.resourceId && input.snapshot.resourceId !== input.resourceId)
    || (input.poolId && input.snapshot.poolId !== input.poolId)
    || Date.parse(input.snapshot.observedAt) > now
    || Date.parse(input.snapshot.expiresAt) <= now
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Protected capacity snapshot is stale or out of scope");
  }
  if (!input.snapshot.headroomSatisfied) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Protected capacity headroom would be violated");
  }
  return input.snapshot;
}
