import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { HardwareInventory } from "@/lib/nodes/contracts";
import { hashHardwareInventory } from "@/lib/nodes/hashes";
import type { NodeBootstrapRecord } from "@/lib/nodes/identity";
import type {
  NodeInventoryRecord,
  NodeInventoryStore
} from "@/lib/persistence/postgres/node-inventory-store";

export const NODE_INVENTORY_SERVICE_VERSION = "1.0.0";

export interface NodeAgentPrincipal {
  nodeId: string;
  portfolioId: string;
  companyId: string;
  credentialId: string;
}

export interface NodeAgentAuthenticator {
  authenticate(request: Request): Promise<NodeAgentPrincipal>;
}

export interface NodeInventoryNodeStore {
  get(id: string): Promise<NodeBootstrapRecord | null>;
}

export interface NodeInventoryServiceDependencies {
  nodes: NodeInventoryNodeStore;
  inventories: NodeInventoryStore;
  now?: () => Date;
}

export class NodeInventoryService {
  private readonly now: () => Date;

  constructor(private readonly deps: NodeInventoryServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async submit(
    principal: NodeAgentPrincipal,
    inventory: HardwareInventory
  ): Promise<NodeInventoryRecord> {
    if (inventory.nodeId !== principal.nodeId) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Node inventory identity does not match authenticated Node"
      );
    }
    if (hashHardwareInventory(inventory) !== inventory.inventoryHash) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Node inventory canonical hash is invalid"
      );
    }

    const node = await this.deps.nodes.get(principal.nodeId);
    if (
      !node
      || node.portfolioId !== principal.portfolioId
      || node.companyId !== principal.companyId
    ) {
      throw new ControlPlaneError("NOT_FOUND", "Enrolled Node was not found");
    }
    if (
      node.platform !== inventory.platform
      || node.architecture !== inventory.architecture
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Node inventory platform or architecture does not match enrollment"
      );
    }

    const receivedAt = this.now().toISOString();
    const record: NodeInventoryRecord = Object.freeze({
      id: `node-inventory-${sha256Hex({
        nodeId: inventory.nodeId,
        inventoryHash: inventory.inventoryHash
      }).slice(0, 32)}`,
      nodeId: inventory.nodeId,
      portfolioId: principal.portfolioId,
      companyId: principal.companyId,
      architecture: inventory.architecture,
      inventoryHash: inventory.inventoryHash,
      discoveredAt: inventory.discoveredAt,
      receivedAt,
      inventory
    });
    return this.deps.inventories.put(record);
  }
}
