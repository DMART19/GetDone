import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { createCorrelationId } from "@/lib/control-plane/request-context";
import {
  getCapability,
  type CapabilityDefinition
} from "@/lib/domain/capabilities";
import type { ResourceCapabilityBinding } from "@/lib/domain/resources";
import type { ResourceRegistryService } from "@/lib/domain/services/resource-registry-service";
import type {
  NodeCapability,
  NodeEnvironment
} from "@/lib/nodes/contracts";
import type { NodeBootstrapRecord } from "@/lib/nodes/identity";

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
    throw new ControlPlaneError(
      "UNAVAILABLE",
      `Node capability bridge target is unavailable in the authoritative Capability Registry: ${name}`
    );
  }
  return capability;
}

function evidenceIds(capabilities: readonly NodeCapability[]) {
  return [...new Set(
    capabilities.flatMap((capability) => [
      capability.id,
      capability.capabilityHash,
      ...capability.evidenceIds
    ])
  )].sort();
}

function bindingFor(
  input: DeriveNodeCapabilityBindingsInput,
  rule: BridgeRule,
  matched: readonly NodeCapability[],
  validated: boolean
): ResourceCapabilityBinding {
  const registryCapability = requireRegistryResourceCapability(
    rule.registryCapability
  );
  const evidence = evidenceIds(matched);
  return Object.freeze({
    id: `node-cap-binding-${sha256Hex({
      resourceId: input.resourceId,
      registryCapability: registryCapability.name,
      validated,
      evidenceIds: evidence
    }).slice(0, 32)}`,
    resourceId: input.resourceId,
    portfolioId: input.portfolioId,
    companyId: input.companyId,
    observedAt: input.observedAt,
    capabilityName: registryCapability.name,
    adapterBinding: registryCapability.adapterBinding,
    validated,
    evidenceIds: Object.freeze(evidence)
  });
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
    bindings.push(bindingFor(input, rule, matched, true));
  }

  return Object.freeze(
    bindings.sort((left, right) =>
      left.capabilityName.localeCompare(right.capabilityName)
    )
  );
}

export function deriveNodeCapabilityReconciliationBindings(
  input: DeriveNodeCapabilityBindingsInput
): readonly ResourceCapabilityBinding[] {
  const byName = new Map(
    input.capabilities.map((capability) => [capability.name, capability])
  );
  const bindings: ResourceCapabilityBinding[] = [];

  for (const rule of bridgeRules) {
    const relevant = rule.nodeCapabilities
      .map((name) => byName.get(name))
      .filter((value): value is NodeCapability => Boolean(value));
    if (relevant.length === 0) continue;

    const validatedNames = new Set(
      relevant
        .filter((capability) => capability.status === "validated")
        .map((capability) => capability.name)
    );
    const satisfied = rule.mode === "all"
      ? rule.nodeCapabilities.every((name) => validatedNames.has(name))
      : validatedNames.size > 0;

    bindings.push(bindingFor(input, rule, relevant, satisfied));
  }

  return Object.freeze(
    bindings.sort((left, right) =>
      left.capabilityName.localeCompare(right.capabilityName)
    )
  );
}

export interface PublishNodeCapabilityBindingsInput {
  node: NodeBootstrapRecord;
  environment: NodeEnvironment;
  capabilities: readonly NodeCapability[];
  observedAt: string;
  correlationId?: string;
}

export class ResourceRegistryNodeCapabilityBridge {
  constructor(
    private readonly registry: Pick<ResourceRegistryService, "addCapabilityBinding">
  ) {}

  async publish(input: PublishNodeCapabilityBindingsInput) {
    if (!input.node.resourceId) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "Node is not yet bound to an authoritative Resource Registry record"
      );
    }
    const bindings = deriveNodeCapabilityReconciliationBindings({
      resourceId: input.node.resourceId,
      portfolioId: input.node.portfolioId,
      companyId: input.node.companyId,
      capabilities: input.capabilities,
      observedAt: input.observedAt
    });
    const correlationId = input.correlationId ?? createCorrelationId();

    for (const binding of bindings) {
      await this.registry.addCapabilityBinding(
        input.node.resourceId,
        binding,
        createCommandEnvelope({
          commandId: crypto.randomUUID(),
          actor: {
            type: "system",
            id: "node-capability-bridge"
          },
          scope: {
            userId: input.node.ownerUserId,
            portfolioId: input.node.portfolioId,
            companyId: input.node.companyId,
            environment: input.environment
          },
          correlationId,
          environment: input.environment,
          idempotencyKey: `node-capability-bridge:${binding.id}`,
          provenance: "node-capability-bridge",
          requestedMutation: {
            type: "resource.capability-binding",
            resourceId: input.node.resourceId,
            capabilityName: binding.capabilityName,
            validated: binding.validated,
            evidenceId: binding.id
          }
        })
      );
    }

    return bindings;
  }
}
