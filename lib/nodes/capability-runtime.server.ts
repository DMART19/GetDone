import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { NodeAgentPrincipal } from "@/lib/nodes/inventory-service";
import type { NodeCapabilityProfile } from "@/lib/nodes/contracts";
import type { NodeCapabilityReconciliationResult } from "@/lib/persistence/postgres/node-capability-store";

export interface NodeCapabilityApplicationAdapter {
  submit(
    principal: NodeAgentPrincipal,
    profile: NodeCapabilityProfile
  ): Promise<NodeCapabilityReconciliationResult>;
}

class UnavailableNodeCapabilityAdapter implements NodeCapabilityApplicationAdapter {
  submit(): Promise<never> {
    return Promise.reject(new ControlPlaneError(
      "UNAVAILABLE",
      "Node capability persistence service is not connected"
    ));
  }
}

let installed: NodeCapabilityApplicationAdapter | null = null;

export function installNodeCapabilityAdapter(
  adapter: NodeCapabilityApplicationAdapter
) {
  installed = adapter;
}

export function resetNodeCapabilityAdapter() {
  installed = null;
}

export function getNodeCapabilityAdapter(): NodeCapabilityApplicationAdapter {
  return installed ?? new UnavailableNodeCapabilityAdapter();
}
