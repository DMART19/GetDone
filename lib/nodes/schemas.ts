import { z } from "zod";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { hashNodeDispatch, hashNodeJobResult } from "@/lib/nodes/hashes";
import type {
  NodeJobDispatch,
  NodeJobResultSubmission
} from "@/lib/nodes/dispatch-contracts";

const id = z.string().trim().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const nonNegativeInt = z.number().int().nonnegative();
const positiveInt = z.number().int().positive();
const percent = z.number().min(0).max(100);

export const nodeArchitectureSchema = z.enum(["x86_64", "arm64"]);
export const nodePlatformSchema = z.literal("linux");
export const nodeEnvironmentSchema = z.enum(["development", "staging", "production"]);
export const nodeDataClassSchema = z.enum(["public", "internal", "customer", "sensitive"]);

export const nodeEnrollmentSchema = z.object({
  id,
  portfolioId: id,
  companyId: id,
  environment: nodeEnvironmentSchema,
  platform: nodePlatformSchema,
  architecture: nodeArchitectureSchema,
  ownerActionRequired: z.boolean(),
  ownerActionDescription: z.string().trim().min(1).max(500).optional(),
  challengeToken: z.string().min(16).max(4096),
  challengeIssuedAt: timestamp.optional(),
  challengeExpiresAt: timestamp
}).strict();

const cpuInventorySchema = z.object({
  architecture: nodeArchitectureSchema,
  vendor: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1),
  sockets: positiveInt,
  physicalCores: positiveInt,
  logicalThreads: positiveInt,
  frequencyMHz: z.number().positive().optional(),
  virtualizationSupported: z.boolean()
}).strict();

const memoryInventorySchema = z.object({
  totalBytes: positiveInt,
  numaNodes: positiveInt.optional()
}).strict();

const gpuDeviceSchema = z.object({
  id,
  vendor: z.enum(["nvidia", "amd", "intel", "other"]),
  model: z.string().trim().min(1),
  memoryBytes: positiveInt.optional(),
  computeCapabilities: z.array(z.string().trim().min(1)),
  driverVersion: z.string().trim().min(1).optional(),
  cudaVersion: z.string().trim().min(1).optional(),
  rocmVersion: z.string().trim().min(1).optional(),
  health: z.enum(["healthy", "degraded", "unavailable"])
}).strict();

const storageDeviceSchema = z.object({
  id,
  device: z.string().trim().min(1),
  mount: z.string().trim().min(1).optional(),
  filesystem: z.string().trim().min(1).optional(),
  totalBytes: nonNegativeInt,
  availableBytes: nonNegativeInt,
  rotational: z.boolean().optional(),
  removable: z.boolean().optional(),
  nvme: z.boolean().optional()
}).strict().refine((value) => value.availableBytes <= value.totalBytes, {
  message: "Storage available bytes cannot exceed total bytes"
});

const networkInterfaceSchema = z.object({
  id,
  name: z.string().trim().min(1),
  macHash: hash.optional(),
  addresses: z.array(z.string().trim().min(1)),
  mtu: positiveInt.optional(),
  linkState: z.enum(["up", "down", "unknown"]),
  linkSpeedMbps: z.number().positive().optional()
}).strict();

export const hardwareInventorySchema = z.object({
  nodeId: id,
  platform: nodePlatformSchema,
  architecture: nodeArchitectureSchema,
  cpu: cpuInventorySchema,
  memory: memoryInventorySchema,
  gpus: z.array(gpuDeviceSchema),
  storage: z.array(storageDeviceSchema),
  network: z.array(networkInterfaceSchema),
  operatingSystem: z.object({
    distribution: z.string().trim().min(1),
    version: z.string().trim().min(1),
    kernel: z.string().trim().min(1)
  }).strict(),
  containerRuntime: z.object({
    type: z.enum(["docker", "containerd", "podman"]),
    version: z.string().trim().min(1)
  }).strict().optional(),
  cgroups: z.object({
    version: z.union([z.literal(1), z.literal(2)]),
    available: z.boolean()
  }).strict(),
  discoveredAt: timestamp,
  inventoryHash: hash
}).strict().superRefine((value, context) => {
  if (value.cpu.architecture !== value.architecture) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cpu", "architecture"],
      message: "CPU architecture must match authoritative inventory architecture"
    });
  }
});

export const nodeCapabilitySchema = z.object({
  id,
  nodeId: id,
  name: z.string().trim().min(1).max(256),
  version: z.string().trim().min(1).optional(),
  status: z.enum(["detected", "validated", "disabled", "degraded"]),
  evidenceIds: z.array(id),
  constraints: z.record(z.unknown()),
  observedAt: timestamp,
  capabilityHash: hash
}).strict();

export const nodeCapabilitySubmissionSchema = z.object({
  nodeId: id,
  capabilities: z.array(nodeCapabilitySchema).max(512),
  submittedAt: timestamp
}).strict();

export const nodeAllocatableProfileSchema = z.object({
  nodeId: id,
  cpuMillicores: positiveInt,
  memoryBytes: positiveInt,
  ephemeralStorageBytes: nonNegativeInt,
  gpuAllocations: z.array(z.object({
    gpuId: id,
    fraction: z.number().positive().max(1)
  }).strict()),
  maxConcurrentJobs: positiveInt,
  executionClasses: z.array(z.string().trim().min(1)),
  allowedDataClasses: z.array(nodeDataClassSchema).min(1),
  networkPolicyId: id.optional(),
  resourceLimits: z.object({
    maxCpuPercent: z.number().positive().max(100).optional(),
    maxMemoryPercent: z.number().positive().max(100).optional(),
    maxDiskBytes: positiveInt.optional(),
    maxNetworkMbps: z.number().positive().optional()
  }).strict(),
  updatedAt: timestamp,
  profileHash: hash
}).strict();

export const nodeHeartbeatSchema = z.object({
  nodeId: id,
  sequence: nonNegativeInt,
  agentVersion: z.string().trim().min(1),
  protocolVersion: z.string().trim().min(1),
  timestamp,
  health: z.enum(["healthy", "degraded"]),
  runningJobs: nonNegativeInt,
  reserved: z.object({
    cpuMillicores: nonNegativeInt,
    memoryBytes: nonNegativeInt,
    storageBytes: nonNegativeInt
  }).strict(),
  available: z.object({
    cpuMillicores: nonNegativeInt,
    memoryBytes: nonNegativeInt,
    storageBytes: nonNegativeInt
  }).strict(),
  load: z.object({
    cpuPercent: percent,
    memoryPercent: percent
  }).strict(),
  heartbeatHash: hash
}).strict();

const nodeResourceUsageSchema = z.object({
  cpuPercent: percent,
  memoryBytes: nonNegativeInt,
  storageBytes: nonNegativeInt.optional(),
  networkRxBytes: nonNegativeInt.optional(),
  networkTxBytes: nonNegativeInt.optional(),
  gpuUtilization: z.array(z.object({
    gpuId: id,
    utilizationPercent: percent,
    memoryBytes: nonNegativeInt.optional(),
    temperatureCelsius: z.number().finite().optional()
  }).strict()).optional()
}).strict();

export const nodeTelemetrySchema = z.object({
  id,
  nodeId: id,
  sequence: nonNegativeInt,
  samples: z.array(z.object({
    observedAt: timestamp,
    usage: nodeResourceUsageSchema,
    loadAverage: z.tuple([z.number(), z.number(), z.number()]).optional(),
    uptimeSeconds: nonNegativeInt.optional(),
    agentUptimeSeconds: nonNegativeInt.optional(),
    oomEvents: nonNegativeInt.optional(),
    diskErrors: nonNegativeInt.optional()
  }).strict()).min(1).max(1024),
  createdAt: timestamp
}).strict();

const lineageShape = {
  id,
  nodeId: id,
  jobId: id,
  reservationId: id,
  authorizationConsumptionHash: hash,
  executionSpecHash: hash,
  createdAt: timestamp,
  expiresAt: timestamp,
  payloadHash: hash
};

const lineageSchema = z.object(lineageShape).strict();

const resourceLimitsSchema = z.object({
  cpuMillicores: positiveInt,
  memoryBytes: positiveInt,
  storageBytes: nonNegativeInt.optional(),
  gpuIds: z.array(id).optional(),
  maxPids: positiveInt.optional()
}).strict();

export const nodeJobDispatchSchema = z.object({
  ...lineageShape,
  architecture: nodeArchitectureSchema,
  capability: z.string().trim().min(1),
  resourceLimits: resourceLimitsSchema,
  workloadReference: z.string().trim().min(1),
  timeoutSeconds: positiveInt
}).strict().refine(
  (value) => Date.parse(value.expiresAt) > Date.parse(value.createdAt),
  { message: "Dispatch expiration must be after creation", path: ["expiresAt"] }
);

export const nodeDispatchAcknowledgementSchema = lineageSchema.extend({
  dispatchId: id,
  accepted: z.boolean(),
  reason: z.string().trim().min(1).optional(),
  observedAt: timestamp
}).strict();

export const nodeJobObservationSchema = lineageSchema.extend({
  dispatchId: id,
  state: z.enum(["received", "prepared", "running", "cancelling", "completed", "failed"]),
  observedAt: timestamp,
  resourceUsage: nodeResourceUsageSchema.optional(),
  localExecutionId: id.optional()
}).strict();

export const nodeJobResultSchema = lineageSchema.extend({
  dispatchId: id,
  localExecutionId: id,
  exitCode: z.number().int().optional(),
  outcome: z.enum(["completed", "failed", "cancelled", "timed-out"]),
  stdoutReference: z.string().trim().min(1).optional(),
  stderrReference: z.string().trim().min(1).optional(),
  artifactReferences: z.array(z.string().trim().min(1)),
  resourceUsage: nodeResourceUsageSchema,
  observedAt: timestamp
}).strict();

export const nodeReservationAcknowledgementSchema = lineageSchema.extend({
  accepted: z.boolean(),
  reason: z.string().trim().min(1).optional(),
  observedAt: timestamp
}).strict();

export const nodeReservationReleaseSchema = lineageSchema.extend({
  reason: z.string().trim().min(1),
  observedAt: timestamp
}).strict();

export const nodeCredentialRotationSchema = z.object({
  nodeId: id,
  currentCredentialId: id,
  newPublicKey: z.string().trim().min(32).max(16384),
  nonce: z.string().trim().min(16).max(512),
  requestedAt: timestamp
}).strict();

export function parseNodeJobDispatch(input: unknown, now = Date.now()): NodeJobDispatch {
  const dispatch = nodeJobDispatchSchema.parse(input) as NodeJobDispatch;
  if (Date.parse(dispatch.expiresAt) <= now) {
    throw new ControlPlaneError("FORBIDDEN", "Node dispatch has expired");
  }
  if (hashNodeDispatch(dispatch) !== dispatch.payloadHash) {
    throw new ControlPlaneError("FORBIDDEN", "Node dispatch hash is invalid");
  }
  return dispatch;
}

export function parseNodeJobResult(input: unknown, now = Date.now()): NodeJobResultSubmission {
  const result = nodeJobResultSchema.parse(input) as NodeJobResultSubmission;
  if (Date.parse(result.expiresAt) <= now) {
    throw new ControlPlaneError("FORBIDDEN", "Node Job result envelope has expired");
  }
  if (hashNodeJobResult(result) !== result.payloadHash) {
    throw new ControlPlaneError("FORBIDDEN", "Node Job result hash is invalid");
  }
  return result;
}
