import { z } from "zod";

const safeId = z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const isoDate = z.string().datetime({ offset: true });
const architecture = z.enum(["x86_64", "arm64"]);
const platform = z.literal("linux");
const environment = z.enum(["development", "staging", "production"]);
const dataClass = z.enum(["public", "internal", "customer", "sensitive"]);
const nonNegativeInt = z.number().int().nonnegative();
const positiveInt = z.number().int().positive();

const scopeEnvelope = {
  id: safeId,
  nodeId: safeId,
  jobId: safeId,
  reservationId: safeId,
  authorizationConsumptionHash: hash,
  executionSpecHash: hash,
  createdAt: isoDate,
  expiresAt: isoDate,
  payloadHash: hash
};

function expiresAfterCreated<T extends { createdAt: string; expiresAt: string }>(value: T) {
  return Date.parse(value.expiresAt) > Date.parse(value.createdAt);
}

export const nodeEnrollmentSchema = z.object({
  id: safeId,
  displayName: z.string().trim().min(1).max(200),
  platform,
  architecture,
  agentVersion: z.string().trim().min(1).max(80),
  protocolVersion: z.string().trim().min(1).max(80),
  requestedEnvironments: z.array(environment).min(1),
  ownerActionRequired: z.boolean(),
  ownerActionDescription: z.string().trim().min(1).max(1000).optional(),
  challengeToken: z.string().min(16).max(4096),
  challengeIssuedAt: isoDate.optional(),
  challengeExpiresAt: isoDate
}).strict();

export const cpuInventorySchema = z.object({
  architecture,
  vendor: z.string().max(200).optional(),
  model: z.string().min(1).max(300),
  sockets: positiveInt,
  physicalCores: positiveInt,
  logicalThreads: positiveInt,
  frequencyMHz: z.number().positive().optional(),
  virtualizationSupported: z.boolean()
}).strict();

export const hardwareInventorySchema = z.object({
  nodeId: safeId,
  platform,
  architecture,
  cpu: cpuInventorySchema,
  memory: z.object({
    totalBytes: positiveInt,
    numaNodes: positiveInt.optional()
  }).strict(),
  gpus: z.array(z.object({
    id: safeId,
    vendor: z.enum(["nvidia", "amd", "intel", "other"]),
    model: z.string().min(1).max(300),
    memoryBytes: nonNegativeInt.optional(),
    computeCapabilities: z.array(z.string().min(1).max(160)),
    driverVersion: z.string().max(160).optional(),
    cudaVersion: z.string().max(160).optional(),
    rocmVersion: z.string().max(160).optional(),
    health: z.enum(["healthy", "degraded", "unavailable"])
  }).strict()),
  storage: z.array(z.object({
    id: safeId,
    device: z.string().min(1).max(500),
    mount: z.string().max(1000).optional(),
    filesystem: z.string().max(100).optional(),
    totalBytes: nonNegativeInt,
    availableBytes: nonNegativeInt,
    rotational: z.boolean(),
    removable: z.boolean(),
    nvme: z.boolean()
  }).strict()),
  network: z.array(z.object({
    id: safeId,
    name: z.string().min(1).max(200),
    macHash: hash.optional(),
    addresses: z.array(z.string().min(1).max(160)),
    mtu: positiveInt.optional(),
    linkState: z.enum(["up", "down", "unknown"]),
    linkSpeedMbps: z.number().nonnegative().optional()
  }).strict()),
  operatingSystem: z.object({
    distribution: z.string().min(1).max(200),
    version: z.string().min(1).max(200),
    kernel: z.string().min(1).max(200)
  }).strict(),
  containerRuntime: z.object({
    type: z.enum(["docker", "containerd", "podman"]),
    version: z.string().min(1).max(160)
  }).strict().optional(),
  cgroups: z.object({
    version: z.union([z.literal(1), z.literal(2)]),
    available: z.boolean()
  }).strict(),
  discoveredAt: isoDate,
  inventoryHash: hash
}).strict().superRefine((value, ctx) => {
  if (value.cpu.architecture !== value.architecture) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "CPU architecture must match node architecture" });
  }
});

export const nodeCapabilitySchema = z.object({
  id: safeId,
  nodeId: safeId,
  name: z.string().trim().min(1).max(200),
  version: z.string().max(160).optional(),
  status: z.enum(["detected", "validated", "disabled", "degraded"]),
  evidenceIds: z.array(safeId),
  constraints: z.record(z.unknown()),
  observedAt: isoDate,
  capabilityHash: hash
}).strict();

export const nodeAllocatableProfileSchema = z.object({
  nodeId: safeId,
  cpuMillicores: positiveInt,
  memoryBytes: positiveInt,
  ephemeralStorageBytes: nonNegativeInt,
  gpuAllocations: z.array(z.object({
    gpuId: safeId,
    fraction: z.number().positive().max(1)
  }).strict()),
  maxConcurrentJobs: positiveInt,
  executionClasses: z.array(z.string().min(1).max(160)),
  allowedDataClasses: z.array(dataClass).min(1),
  networkPolicyId: safeId.optional(),
  resourceLimits: z.object({
    maxCpuPercent: z.number().positive().max(100).optional(),
    maxMemoryPercent: z.number().positive().max(100).optional(),
    maxDiskBytes: nonNegativeInt.optional(),
    maxNetworkMbps: z.number().nonnegative().optional()
  }).strict(),
  updatedAt: isoDate,
  profileHash: hash
}).strict();

export const nodeHeartbeatSchema = z.object({
  nodeId: safeId,
  sequence: nonNegativeInt,
  agentVersion: z.string().min(1).max(80),
  protocolVersion: z.string().min(1).max(80),
  timestamp: isoDate,
  health: z.enum(["healthy", "delayed", "degraded"]),
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
    cpuPercent: z.number().nonnegative().max(100),
    memoryPercent: z.number().nonnegative().max(100)
  }).strict(),
  heartbeatHash: hash
}).strict();

export const nodeTelemetryBatchSchema = z.object({
  nodeId: safeId,
  sequence: nonNegativeInt,
  observedAt: isoDate,
  samples: z.array(z.object({
    observedAt: isoDate,
    usage: z.object({
      cpuPercent: z.number().nonnegative().max(100),
      memoryPercent: z.number().nonnegative().max(100),
      memoryBytes: nonNegativeInt,
      storageBytes: nonNegativeInt.optional(),
      networkRxBytes: nonNegativeInt.optional(),
      networkTxBytes: nonNegativeInt.optional(),
      gpu: z.array(z.object({
        gpuId: safeId,
        utilizationPercent: z.number().nonnegative().max(100).optional(),
        memoryBytes: nonNegativeInt.optional(),
        temperatureCelsius: z.number().optional()
      }).strict()).optional()
    }).strict()
  }).strict()).max(120),
  telemetryHash: hash
}).strict();

export const nodeJobDispatchSchema = z.object({
  ...scopeEnvelope,
  architecture,
  capability: z.string().trim().min(1).max(200),
  resourceLimits: z.object({
    cpuMillicores: positiveInt,
    memoryBytes: positiveInt,
    storageBytes: nonNegativeInt.optional(),
    gpuIds: z.array(safeId).optional()
  }).strict()
}).strict().refine(expiresAfterCreated, {
  message: "dispatch must expire after creation"
});

export const nodeDispatchAcknowledgementSchema = z.object({
  ...scopeEnvelope,
  accepted: z.boolean(),
  reason: z.string().min(1).max(1000).optional()
}).strict().refine(expiresAfterCreated, {
  message: "dispatch acknowledgement must expire after creation"
});

export const nodeJobObservationSchema = z.object({
  ...scopeEnvelope,
  state: z.enum(["accepted", "starting", "running", "completed", "failed", "cancelled"]),
  observedAt: isoDate,
  exitCode: z.number().int().optional()
}).strict().refine(expiresAfterCreated, {
  message: "Job observation must expire after creation"
});

export const nodeJobResultSchema = z.object({
  ...scopeEnvelope,
  observedAt: isoDate,
  exitCode: z.number().int(),
  stdoutReference: z.string().min(1).max(1000).optional(),
  stderrReference: z.string().min(1).max(1000).optional(),
  artifactReferences: z.array(z.string().min(1).max(1000)),
  durationMs: nonNegativeInt
}).strict().refine(expiresAfterCreated, {
  message: "Job result must expire after creation"
});

export const nodeReservationAcknowledgementSchema = z.object({
  ...scopeEnvelope,
  accepted: z.boolean(),
  reason: z.string().min(1).max(1000).optional()
}).strict().refine(expiresAfterCreated, {
  message: "reservation acknowledgement must expire after creation"
});

export const nodeReservationReleaseSchema = z.object({
  ...scopeEnvelope,
  releasedAt: isoDate
}).strict().refine(expiresAfterCreated, {
  message: "reservation release must expire after creation"
});

export const nodeCredentialRotationSchema = z.object({
  id: safeId,
  nodeId: safeId,
  currentCredentialId: safeId,
  requestedPublicKey: z.string().min(32).max(8192),
  nonce: z.string().min(16).max(512),
  createdAt: isoDate,
  expiresAt: isoDate,
  idempotencyKey: safeId
}).strict().refine(expiresAfterCreated, {
  message: "credential rotation request must expire after creation"
});


export const nodeControlEnrollmentCreateSchema = z.object({
  id: safeId,
  displayName: z.string().trim().min(1).max(200),
  architecture,
  ownerActionRequired: z.boolean(),
  ownerActionDescription: z.string().trim().min(1).max(1000).optional()
}).strict();

export const nodeControlEnrollmentActionSchema = z.object({
  action: z.enum(["owner-action", "cancel", "expire"]),
  evidenceId: safeId.optional()
}).strict().superRefine((value, ctx) => {
  if (value.action === "owner-action" && !value.evidenceId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "owner-action requires evidenceId"
    });
  }
});

export const nodeAgentBootstrapSchema = z.object({
  enrollmentToken: z.string().min(32).max(512),
  agentVersion: z.string().trim().min(1).max(80),
  protocolVersion: z.string().trim().min(1).max(80),
  architecture,
  bootstrapPublicKey: z.string().min(32).max(8192),
  nonce: z.string().min(16).max(512)
}).strict();
