import type { Resource } from "@/lib/domain/resources";

export const NODE_DOMAIN_VERSION = "1.0.0";
export const NODE_AGENT_PROTOCOL_VERSION = "1.0.0";

export type NodeArchitecture = "x86_64" | "arm64";
export type NodePlatform = "linux";
export type NodeEnvironment = Resource["environmentPermissions"][number];
export type NodeDataClass = Resource["dataClassesAllowed"][number];

export type NodeState =
  | "identified"
  | "enrolling"
  | "authenticating"
  | "profiling"
  | "validating"
  | "ready"
  | "degraded"
  | "draining"
  | "offline"
  | "quarantined"
  | "retired";

export type NodeTrustClass =
  | "untrusted"
  | "verified"
  | "trusted-local"
  | "trusted-datacenter";

export type NodeHealthState =
  | "healthy"
  | "delayed"
  | "degraded"
  | "offline"
  | "quarantined";

export interface NodeRecord {
  id: string;
  portfolioId: string;
  companyId: string;
  resourceId: string;
  displayName: string;
  platform: NodePlatform;
  architecture: NodeArchitecture;
  agentVersion: string;
  protocolVersion: string;
  state: NodeState;
  trustClass: NodeTrustClass;
  environmentPermissions: readonly NodeEnvironment[];
  failureDomainIds: readonly string[];
  policyBindingIds: readonly string[];
  credentialBindingIds: readonly string[];
  capabilityProfileId: string;
  allocatableProfileId: string;
  lastHeartbeatAt?: string;
  lastInventoryAt?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CPUInventory {
  architecture: NodeArchitecture;
  vendor?: string;
  model: string;
  sockets: number;
  physicalCores: number;
  logicalThreads: number;
  frequencyMHz?: number;
  virtualizationSupported: boolean;
}

export interface MemoryInventory {
  totalBytes: number;
  numaNodes?: number;
}

export interface GPUDevice {
  id: string;
  vendor: "nvidia" | "amd" | "intel" | "other";
  model: string;
  memoryBytes?: number;
  computeCapabilities: readonly string[];
  driverVersion?: string;
  cudaVersion?: string;
  rocmVersion?: string;
  health: "healthy" | "degraded" | "unavailable";
}

export interface StorageDevice {
  id: string;
  device: string;
  mount?: string;
  filesystem?: string;
  totalBytes: number;
  availableBytes: number;
  rotational: boolean;
  removable: boolean;
  nvme: boolean;
}

export interface NetworkInterface {
  id: string;
  name: string;
  macHash?: string;
  addresses: readonly string[];
  mtu?: number;
  linkState: "up" | "down" | "unknown";
  linkSpeedMbps?: number;
}

export interface HardwareInventory {
  nodeId: string;
  platform: NodePlatform;
  architecture: NodeArchitecture;
  cpu: CPUInventory;
  memory: MemoryInventory;
  gpus: readonly GPUDevice[];
  storage: readonly StorageDevice[];
  network: readonly NetworkInterface[];
  operatingSystem: {
    distribution: string;
    version: string;
    kernel: string;
  };
  containerRuntime?: {
    type: "docker" | "containerd" | "podman";
    version: string;
  };
  cgroups: {
    version: 1 | 2;
    available: boolean;
  };
  discoveredAt: string;
  inventoryHash: string;
}

export interface NodeCapability {
  id: string;
  nodeId: string;
  name: string;
  version?: string;
  status: "detected" | "validated" | "disabled" | "degraded";
  evidenceIds: readonly string[];
  constraints: Readonly<Record<string, unknown>>;
  observedAt: string;
  capabilityHash: string;
}

export interface NodeCapabilityProfile {
  nodeId: string;
  observedAt: string;
  capabilities: readonly NodeCapability[];
  profileHash: string;
}

export interface NodeAllocatableProfile {
  nodeId: string;
  cpuMillicores: number;
  memoryBytes: number;
  ephemeralStorageBytes: number;
  gpuAllocations: readonly {
    gpuId: string;
    fraction: number;
  }[];
  maxConcurrentJobs: number;
  executionClasses: readonly string[];
  allowedDataClasses: readonly NodeDataClass[];
  networkPolicyId?: string;
  resourceLimits: {
    maxCpuPercent?: number;
    maxMemoryPercent?: number;
    maxDiskBytes?: number;
    maxNetworkMbps?: number;
  };
  updatedAt: string;
  profileHash: string;
}

export interface NodeResourceUsage {
  cpuPercent: number;
  memoryPercent: number;
  memoryBytes: number;
  storageBytes?: number;
  networkRxBytes?: number;
  networkTxBytes?: number;
  gpu?: readonly {
    gpuId: string;
    utilizationPercent?: number;
    memoryBytes?: number;
    temperatureCelsius?: number;
  }[];
}

export interface NodeHeartbeat {
  nodeId: string;
  sequence: number;
  agentVersion: string;
  protocolVersion: string;
  timestamp: string;
  health: Exclude<NodeHealthState, "offline" | "quarantined">;
  runningJobs: number;
  reserved: {
    cpuMillicores: number;
    memoryBytes: number;
    storageBytes: number;
  };
  available: {
    cpuMillicores: number;
    memoryBytes: number;
    storageBytes: number;
  };
  load: {
    cpuPercent: number;
    memoryPercent: number;
  };
  heartbeatHash: string;
}

export interface NodeTelemetryBatch {
  nodeId: string;
  sequence: number;
  observedAt: string;
  samples: readonly {
    observedAt: string;
    usage: NodeResourceUsage;
  }[];
  telemetryHash: string;
}

export interface NodeFailureDomainBinding {
  id: string;
  nodeId: string;
  failureDomainId: string;
  failureDomainClass:
    | "machine"
    | "rack"
    | "room"
    | "building"
    | "site"
    | "availability-zone"
    | "region"
    | "provider"
    | "power"
    | "network";
  observedAt: string;
  evidenceIds: readonly string[];
}
