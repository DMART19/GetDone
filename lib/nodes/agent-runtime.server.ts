import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  NodeAgentAuthenticator,
  NodeAgentPrincipal
} from "@/lib/nodes/inventory-service";
import type { HardwareInventory } from "@/lib/nodes/contracts";
import type { NodeInventoryRecord } from "@/lib/persistence/postgres/node-inventory-store";

export interface NodeInventoryApplicationAdapter {
  submit(
    principal: NodeAgentPrincipal,
    inventory: HardwareInventory
  ): Promise<NodeInventoryRecord>;
}

class UnavailableNodeAgentAuthenticator implements NodeAgentAuthenticator {
  authenticate(): Promise<never> {
    return Promise.reject(new ControlPlaneError(
      "UNAVAILABLE",
      "Authenticated Node Agent transport is not connected"
    ));
  }
}

class UnavailableNodeInventoryAdapter implements NodeInventoryApplicationAdapter {
  submit(): Promise<never> {
    return Promise.reject(new ControlPlaneError(
      "UNAVAILABLE",
      "Node inventory persistence service is not connected"
    ));
  }
}

let authenticator: NodeAgentAuthenticator | null = null;
let inventory: NodeInventoryApplicationAdapter | null = null;

export function installNodeAgentAuthenticator(value: NodeAgentAuthenticator) {
  authenticator = value;
}

export function resetNodeAgentAuthenticator() {
  authenticator = null;
}

export function getNodeAgentAuthenticator(): NodeAgentAuthenticator {
  return authenticator ?? new UnavailableNodeAgentAuthenticator();
}

export function installNodeInventoryAdapter(value: NodeInventoryApplicationAdapter) {
  inventory = value;
}

export function resetNodeInventoryAdapter() {
  inventory = null;
}

export function getNodeInventoryAdapter(): NodeInventoryApplicationAdapter {
  return inventory ?? new UnavailableNodeInventoryAdapter();
}
