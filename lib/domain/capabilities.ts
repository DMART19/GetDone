import type { ZodTypeAny } from "zod";
import { ZodError } from "zod";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { capabilitySchemaRegistry, type CapabilityName } from "@/lib/domain/capability-schemas";

export type CapabilityAccess = "read" | "write";
export type CapabilityRisk = "low" | "medium" | "high" | "critical";
export type ApprovalRequirement = "auto" | "approval" | "strong-approval" | "blocked";

export interface CapabilityDefinition {
  name: CapabilityName;
  description: string;
  access: CapabilityAccess;
  sensitivity: "public" | "internal" | "customer" | "sensitive";
  productionEffect: boolean;
  reversible: boolean;
  risk: CapabilityRisk;
  blastRadius: "single-object" | "company" | "portfolio" | "infrastructure";
  approval: ApprovalRequirement;
  adapterBinding: string;
  rateLimitPerMinute: number;
  enabled: boolean;
  inputSchema: ZodTypeAny;
  outputSchema: ZodTypeAny;
  costModel: "none" | "metered" | "provider";
}

export const capabilityRegistry: readonly CapabilityDefinition[] = [
  {
    name: "revenue.read",
    description: "Read authorized revenue summaries",
    access: "read",
    sensitivity: "internal",
    productionEffect: false,
    reversible: true,
    risk: "low",
    blastRadius: "single-object",
    approval: "auto",
    adapterBinding: "business.revenue",
    rateLimitPerMinute: 60,
    enabled: true,
    inputSchema: capabilitySchemaRegistry["revenue.read"].input,
    outputSchema: capabilitySchemaRegistry["revenue.read"].output,
    costModel: "none"
  },
  {
    name: "email.send",
    description: "Send an authorized outbound email",
    access: "write",
    sensitivity: "customer",
    productionEffect: true,
    reversible: false,
    risk: "medium",
    blastRadius: "single-object",
    approval: "approval",
    adapterBinding: "business.email",
    rateLimitPerMinute: 20,
    enabled: true,
    inputSchema: capabilitySchemaRegistry["email.send"].input,
    outputSchema: capabilitySchemaRegistry["email.send"].output,
    costModel: "provider"
  },
  {
    name: "repository.inspect",
    description: "Read repository metadata and code",
    access: "read",
    sensitivity: "internal",
    productionEffect: false,
    reversible: true,
    risk: "low",
    blastRadius: "single-object",
    approval: "auto",
    adapterBinding: "software.repository",
    rateLimitPerMinute: 60,
    enabled: true,
    inputSchema: capabilitySchemaRegistry["repository.inspect"].input,
    outputSchema: capabilitySchemaRegistry["repository.inspect"].output,
    costModel: "provider"
  },
  {
    name: "production.deploy",
    description: "Promote a verified software release to production",
    access: "write",
    sensitivity: "sensitive",
    productionEffect: true,
    reversible: true,
    risk: "critical",
    blastRadius: "company",
    approval: "strong-approval",
    adapterBinding: "software.deploy",
    rateLimitPerMinute: 5,
    enabled: true,
    inputSchema: capabilitySchemaRegistry["production.deploy"].input,
    outputSchema: capabilitySchemaRegistry["production.deploy"].output,
    costModel: "provider"
  },
  {
    name: "compute.cpu.light",
    description: "Execute a bounded lightweight CPU workload",
    access: "write",
    sensitivity: "internal",
    productionEffect: false,
    reversible: true,
    risk: "medium",
    blastRadius: "single-object",
    approval: "approval",
    adapterBinding: "resource.compute",
    rateLimitPerMinute: 30,
    enabled: true,
    inputSchema: capabilitySchemaRegistry["compute.cpu.light"].input,
    outputSchema: capabilitySchemaRegistry["compute.cpu.light"].output,
    costModel: "metered"
  },
  {
    name: "compute.gpu.inference",
    description: "Execute an eligible GPU inference workload",
    access: "write",
    sensitivity: "customer",
    productionEffect: false,
    reversible: true,
    risk: "medium",
    blastRadius: "single-object",
    approval: "approval",
    adapterBinding: "resource.compute",
    rateLimitPerMinute: 30,
    enabled: true,
    inputSchema: capabilitySchemaRegistry["compute.gpu.inference"].input,
    outputSchema: capabilitySchemaRegistry["compute.gpu.inference"].output,
    costModel: "metered"
  },
  {
    name: "storage.backup",
    description: "Write an authorized backup artifact",
    access: "write",
    sensitivity: "sensitive",
    productionEffect: false,
    reversible: true,
    risk: "high",
    blastRadius: "company",
    approval: "approval",
    adapterBinding: "resource.storage",
    rateLimitPerMinute: 12,
    enabled: true,
    inputSchema: capabilitySchemaRegistry["storage.backup"].input,
    outputSchema: capabilitySchemaRegistry["storage.backup"].output,
    costModel: "metered"
  },
  {
    name: "resource.health.read",
    description: "Read validated resource-health summaries",
    access: "read",
    sensitivity: "internal",
    productionEffect: false,
    reversible: true,
    risk: "low",
    blastRadius: "single-object",
    approval: "auto",
    adapterBinding: "resource.health",
    rateLimitPerMinute: 120,
    enabled: true,
    inputSchema: capabilitySchemaRegistry["resource.health.read"].input,
    outputSchema: capabilitySchemaRegistry["resource.health.read"].output,
    costModel: "none"
  }
];

export function getCapability(name: string) {
  return capabilityRegistry.find((capability) => capability.name === name);
}

export function requireEnabledCapability(name: string) {
  const capability = getCapability(name);
  if (!capability || !capability.enabled) {
    throw new ControlPlaneError("POLICY_BLOCKED", `Capability is unavailable: ${name}`);
  }
  return capability;
}

function validationFailure(name: string, direction: "input" | "output", error: ZodError) {
  throw new ControlPlaneError("VALIDATION_FAILED", `Invalid ${direction} for capability ${name}`, {
    details: {
      issueCount: error.issues.length,
      issuePaths: error.issues.map((issue) => issue.path.join(".")).join(",")
    }
  });
}

export function validateCapabilityInput<T = unknown>(name: string, payload: unknown): T {
  const capability = requireEnabledCapability(name);
  const result = capability.inputSchema.safeParse(payload);
  if (!result.success) validationFailure(name, "input", result.error);
  return result.data as T;
}

export function validateCapabilityOutput<T = unknown>(name: string, payload: unknown): T {
  const capability = requireEnabledCapability(name);
  const result = capability.outputSchema.safeParse(payload);
  if (!result.success) validationFailure(name, "output", result.error);
  return result.data as T;
}
