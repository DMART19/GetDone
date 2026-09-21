import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  isSupportedNodeCapabilityName
} from "@/lib/nodes/capability-catalog";
import type {
  NodeCapability,
  NodeCapabilityProfile
} from "@/lib/nodes/contracts";
import {
  hashNodeCapability,
  hashNodeCapabilityProfile
} from "@/lib/nodes/hashes";
import type { NodeAgentPrincipal } from "@/lib/nodes/inventory-service";
import type { NodeBootstrapRecord } from "@/lib/nodes/identity";
import type { NodeInventoryRecord } from "@/lib/persistence/postgres/node-inventory-store";
import type {
  NodeCapabilityProfileRecord,
  NodeCapabilityReconciliationResult,
  NodeCapabilityStore
} from "@/lib/persistence/postgres/node-capability-store";

export const NODE_CAPABILITY_SERVICE_VERSION = "1.0.0";

export interface NodeCapabilityNodeStore {
  get(id: string): Promise<NodeBootstrapRecord | null>;
}

export interface NodeCapabilityInventoryStore {
  getLatest(nodeId: string): Promise<NodeInventoryRecord | null>;
}

export interface NodeCapabilityServiceDependencies {
  nodes: NodeCapabilityNodeStore;
  inventories: NodeCapabilityInventoryStore;
  capabilities: NodeCapabilityStore;
  now?: () => Date;
}

function assertAgentCapability(capability: NodeCapability) {
  if (!isSupportedNodeCapabilityName(capability.name)) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      `Unsupported Node capability: ${capability.name}`
    );
  }
  if (capability.status !== "detected" && capability.status !== "validated") {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Node Agent may submit only detected or validated capability observations"
    );
  }
  if (hashNodeCapability(capability) !== capability.capabilityHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      `Node capability hash is invalid: ${capability.name}`
    );
  }
}

export class NodeCapabilityService {
  private readonly now: () => Date;

  constructor(private readonly deps: NodeCapabilityServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async submit(
    principal: NodeAgentPrincipal,
    profile: NodeCapabilityProfile
  ): Promise<NodeCapabilityReconciliationResult> {
    if (profile.nodeId !== principal.nodeId) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Node capability profile identity does not match authenticated Node"
      );
    }
    if (hashNodeCapabilityProfile(profile) !== profile.profileHash) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Node capability profile canonical hash is invalid"
      );
    }

    for (const capability of profile.capabilities) {
      if (
        capability.nodeId !== profile.nodeId
        || capability.observedAt !== profile.observedAt
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Node capability observation scope does not match the submitted profile"
        );
      }
      assertAgentCapability(capability);
    }

    const node = await this.deps.nodes.get(principal.nodeId);
    if (
      !node
      || node.portfolioId !== principal.portfolioId
      || node.companyId !== principal.companyId
    ) {
      throw new ControlPlaneError("NOT_FOUND", "Enrolled Node was not found");
    }

    const inventory = await this.deps.inventories.getLatest(node.id);
    if (
      !inventory
      || inventory.nodeId !== node.id
      || inventory.portfolioId !== node.portfolioId
      || inventory.companyId !== node.companyId
      || inventory.architecture !== node.architecture
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Authoritative Node inventory is required before capability profiling"
      );
    }

    const cuda = profile.capabilities.find(
      (capability) => capability.name === "gpu.cuda"
    );
    if (
      cuda
      && !inventory.inventory.gpus.some(
        (gpu) => gpu.vendor === "nvidia" && gpu.health !== "unavailable"
      )
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "CUDA capability evidence is inconsistent with authoritative hardware inventory"
      );
    }

    const receivedAt = this.now().toISOString();
    const record: NodeCapabilityProfileRecord = Object.freeze({
      id: `node-cap-profile-${sha256Hex({
        nodeId: profile.nodeId,
        profileHash: profile.profileHash
      }).slice(0, 32)}`,
      nodeId: profile.nodeId,
      portfolioId: node.portfolioId,
      companyId: node.companyId,
      profileHash: profile.profileHash,
      observedAt: profile.observedAt,
      receivedAt,
      profile
    });
    return this.deps.capabilities.replaceProfile(record);
  }
}
