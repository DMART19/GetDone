import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  HardwareInventory,
  NodeAllocatableProfile,
  NodeCapability,
  NodeHeartbeat
} from "@/lib/nodes/contracts";
import type {
  NodeJobDispatch,
  NodeJobResultSubmission
} from "@/lib/nodes/dispatch-contracts";

function withoutHash<T extends Record<string, unknown>, K extends keyof T>(
  value: T,
  key: K
): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

export function hashHardwareInventory(
  inventory: Omit<HardwareInventory, "inventoryHash"> | HardwareInventory
) {
  return sha256Hex(withoutHash(inventory as HardwareInventory & Record<string, unknown>, "inventoryHash"));
}

export function hashNodeCapability(
  capability: Omit<NodeCapability, "capabilityHash"> | NodeCapability
) {
  return sha256Hex(withoutHash(capability as NodeCapability & Record<string, unknown>, "capabilityHash"));
}

export function hashAllocatableProfile(
  profile: Omit<NodeAllocatableProfile, "profileHash"> | NodeAllocatableProfile
) {
  return sha256Hex(withoutHash(profile as NodeAllocatableProfile & Record<string, unknown>, "profileHash"));
}

export function hashNodeHeartbeat(
  heartbeat: Omit<NodeHeartbeat, "heartbeatHash"> | NodeHeartbeat
) {
  return sha256Hex(withoutHash(heartbeat as NodeHeartbeat & Record<string, unknown>, "heartbeatHash"));
}

export function hashNodeDispatch(
  dispatch: Omit<NodeJobDispatch, "payloadHash"> | NodeJobDispatch
) {
  return sha256Hex(withoutHash(dispatch as NodeJobDispatch & Record<string, unknown>, "payloadHash"));
}

export function hashNodeJobResult(
  result: Omit<NodeJobResultSubmission, "payloadHash"> | NodeJobResultSubmission
) {
  return sha256Hex(withoutHash(result as NodeJobResultSubmission & Record<string, unknown>, "payloadHash"));
}

export function assertNodeDispatchIntegrity(dispatch: NodeJobDispatch) {
  if (hashNodeDispatch(dispatch) !== dispatch.payloadHash) {
    throw new ControlPlaneError("FORBIDDEN", "Node dispatch payload hash is invalid");
  }
  return dispatch;
}

export function assertNodeJobResultIntegrity(result: NodeJobResultSubmission) {
  if (hashNodeJobResult(result) !== result.payloadHash) {
    throw new ControlPlaneError("FORBIDDEN", "Node Job result payload hash is invalid");
  }
  return result;
}
