import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  getCapability,
  type CapabilityDefinition
} from "@/lib/domain/capabilities";
import type { ResourceCapabilityBinding } from "@/lib/domain/resources";
import type { NodeCapability } from "@/lib/nodes/contracts";

export const NODE_CAPABILITY_BRIDGE_VERSION = "1.0.0";

interface BridgeRule {
  nodeCapabilities: readonly string[];
  registryCapability: string;
  mode: "any" | "all";
}

const bridgeRules: readonly BridgeRule[] = Object.freeze([
  {
    nodeCapabilities: ["runtime.docker", "runtime.containerd"],
    registryCapability: "compute.cpu.light",
    mode: "any"
  },
  {
    nodeCapabilities: ["gpu.cuda"],
    registryCapability: "compute.gpu.inference",
    mode: "all"
  }
]);

function requireRegistryResourceCapability(name: string): CapabilityDefinition {
  const capability = getCapability(name);
  if (
    !capability
    || !capability.enabled
    || !capability.adapterBinding.startsWith("resource.")
  ) {
    throw new Error(
      `Node capability bridge target is unavailable in the authoritative Capability Registry: ${name}`
    );
  }
  return capability;
}

export interface DeriveNodeCapabilityBindingsInput {
  resourceId: string;
  portfolioId: string;
  companyId: string;
  capabilities: readonly NodeCapability[];
  observedAt: string;
}

export function deriveNodeCapabilityBindings(
  input: DeriveNodeCapabilityBindingsInput
): readonly ResourceCapabilityBinding[] {
  const validatedByName = new Map(
    input.capabilities
      .filter((capability) => capability.status === "validated")
      .map((capability) => [capability.name, capability])
  );

  const bindings: ResourceCapabilityBinding[] = [];

  for (const rule of bridgeRules) {
    const matched = rule.nodeCapabilities
      .map((name) => validatedByName.get(name))
      .filter((value): value is NodeCapability => Boolean(value));
    const satisfied = rule.mode === "all"
      ? matched.length === rule.nodeCapabilities.length
      : matched.length > 0;
    if (!satisfied) continue;

    const registryCapability = requireRegistryResourceCapability(
      rule.registryCapability
    );
    const evidenceIds = [...new Set(
      matched.flatMap((capability) => [
        capability.id,
        capability.capabilityHash,
        ...capability.evidenceIds
      ])
    )].sort();

    bindings.push(Object.freeze({
      id: `node-cap-binding-${sha256Hex({
        resourceId: input.resourceId,
        registryCapability: registryCapability.name,
        evidenceIds
      }).slice(0, 32)}`,
      resourceId: input.resourceId,
      portfolioId: input.portfolioId,
      companyId: input.companyId,
      observedAt: input.observedAt,
      capabilityName: registryCapability.name,
      adapterBinding: registryCapability.adapterBinding,
      validated: true,
      evidenceIds: Object.freeze(evidenceIds)
    }));
  }

  return Object.freeze(
    bindings.sort((left, right) =>
      left.capabilityName.localeCompare(right.capabilityName)
    )
  );
}
