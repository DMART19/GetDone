import { ControlPlaneError } from "@/lib/control-plane/errors";

export type CapabilityAccess = "read" | "write";
export type CapabilityRisk = "low" | "medium" | "high" | "critical";
export type ApprovalRequirement = "auto" | "approval" | "strong-approval" | "blocked";

export interface CapabilityDefinition {
  name: string;
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
  inputSchema: string;
  outputSchema: string;
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
    inputSchema: "RevenueReadInput",
    outputSchema: "RevenueSummary",
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
    inputSchema: "EmailSendInput",
    outputSchema: "EmailSendResult",
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
    inputSchema: "RepositoryInspectInput",
    outputSchema: "RepositoryInspection",
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
    inputSchema: "ProductionDeployInput",
    outputSchema: "DeploymentResult",
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
    inputSchema: "ComputeWorkloadInput",
    outputSchema: "ComputeWorkloadResult",
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
    inputSchema: "GpuInferenceInput",
    outputSchema: "GpuInferenceResult",
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
    inputSchema: "StorageBackupInput",
    outputSchema: "StorageBackupResult",
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
    inputSchema: "ResourceHealthReadInput",
    outputSchema: "ResourceHealthSummary",
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
