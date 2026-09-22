import { z } from "zod";

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/);
const companyId = id;
const resourceId = id;
const isoDateTime = z.string().datetime({ offset: true });
const environment = z.enum(["development", "staging", "production"]);
const dataClass = z.enum(["public", "internal", "customer", "sensitive"]);
const repository = z.string().regex(/^(?!\.{1,2}\/)(?!.*\/\.{1,2}$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const commitSha = z.string().regex(/^[a-fA-F0-9]{7,40}$/);
const currency = z.string().length(3).regex(/^[A-Z]{3}$/);

export const RevenueReadInputSchema = z.object({
  companyId,
  period: z.object({
    start: isoDateTime,
    end: isoDateTime
  }).strict(),
  currency: currency.default("USD")
}).strict().refine((value) => Date.parse(value.period.start) <= Date.parse(value.period.end), {
  message: "period.start must be before or equal to period.end",
  path: ["period"]
});

export const RevenueSummarySchema = z.object({
  companyId,
  period: z.object({ start: isoDateTime, end: isoDateTime }).strict(),
  currency,
  grossCents: z.number().int().nonnegative(),
  netCents: z.number().int(),
  sourceUpdatedAt: isoDateTime
}).strict();

export const EmailSendInputSchema = z.object({
  companyId,
  to: z.array(z.string().email()).min(1).max(50),
  cc: z.array(z.string().email()).max(50).default([]),
  subject: z.string().min(1).max(200),
  text: z.string().max(100_000).optional(),
  html: z.string().max(200_000).optional(),
  replyTo: z.string().email().optional()
}).strict().refine((value) => Boolean(value.text || value.html), {
  message: "email requires text or html content"
});

export const EmailSendResultSchema = z.object({
  messageId: id,
  providerReference: z.string().min(1).max(500),
  accepted: z.array(z.string().email()),
  rejected: z.array(z.string().email()),
  acceptedAt: isoDateTime
}).strict();

export const RepositoryInspectInputSchema = z.object({
  companyId,
  repository,
  ref: z.string().min(1).max(255).optional(),
  paths: z.array(z.string().min(1).max(1024)).max(100).optional()
}).strict();

export const RepositoryInspectionSchema = z.object({
  repository,
  resolvedRef: z.string().min(1).max(255),
  files: z.array(z.object({
    path: z.string().min(1).max(1024),
    sha: z.string().min(7).max(64),
    sizeBytes: z.number().int().nonnegative()
  }).strict()).max(5_000),
  truncated: z.boolean()
}).strict();

export const ProductionDeployInputSchema = z.object({
  companyId,
  repository,
  commitSha,
  environment: z.literal("production"),
  deploymentId: id,
  rollbackRef: z.string().min(1).max(255),
  verificationChecks: z.array(z.string().min(1).max(160)).min(1).max(100)
}).strict();

export const DeploymentResultSchema = z.object({
  deploymentId: id,
  commitSha,
  environment: z.literal("production"),
  status: z.enum(["accepted", "running", "verifying", "succeeded", "failed", "rolled-back"]),
  providerReference: z.string().min(1).max(500).optional(),
  verificationEvidenceIds: z.array(id).max(100).default([])
}).strict();

const workloadBase = z.object({
  companyId,
  workloadId: id,
  environment,
  dataClass,
  cpuCores: z.number().positive().max(64),
  memoryMb: z.number().int().positive().max(262_144),
  durationSeconds: z.number().int().positive().max(3_600)
});

export const ComputeWorkloadInputSchema = workloadBase.extend({
  workloadType: z.enum(["health-check", "build", "test", "batch-transform"]),
  artifactRef: z.string().min(1).max(1024).optional()
}).strict();

export const ComputeWorkloadResultSchema = z.object({
  workloadId: id,
  resourceId,
  status: z.enum(["accepted", "running", "succeeded", "failed", "cancelled"]),
  startedAt: isoDateTime,
  finishedAt: isoDateTime.optional(),
  exitCode: z.number().int().optional(),
  artifactRefs: z.array(z.string().min(1).max(1024)).max(100).default([])
}).strict();

export const GpuInferenceInputSchema = workloadBase.extend({
  modelRef: z.string().min(1).max(500),
  inputRef: z.string().min(1).max(1024),
  maxOutputTokens: z.number().int().positive().max(100_000).optional()
}).strict();

export const GpuInferenceResultSchema = z.object({
  workloadId: id,
  resourceId,
  status: z.enum(["accepted", "running", "succeeded", "failed", "cancelled"]),
  outputRef: z.string().min(1).max(1024).optional(),
  gpuSeconds: z.number().nonnegative(),
  startedAt: isoDateTime,
  finishedAt: isoDateTime.optional()
}).strict();

export const StorageBackupInputSchema = z.object({
  companyId,
  sourceRef: z.string().min(1).max(1024),
  destinationClass: z.enum(["owned-secondary", "cloud-backup", "archive"]),
  retentionDays: z.number().int().positive().max(3650),
  encryptionRequired: z.literal(true),
  dataClass
}).strict();

export const StorageBackupResultSchema = z.object({
  backupId: id,
  status: z.enum(["accepted", "running", "verified", "failed"]),
  checksum: z.string().min(8).max(256).optional(),
  bytesWritten: z.number().int().nonnegative(),
  evidenceId: id.optional()
}).strict();

export const ResourceHealthReadInputSchema = z.object({
  companyId,
  resourceId
}).strict();

export const ResourceHealthSummarySchema = z.object({
  resourceId,
  status: z.enum([
    "discovered",
    "enrolling",
    "profiling",
    "validating",
    "ready",
    "degraded",
    "saturated",
    "draining",
    "unreachable",
    "failed",
    "quarantined",
    "maintenance",
    "disabled"
  ]),
  telemetryAt: isoDateTime,
  checks: z.array(z.object({
    name: z.string().min(1).max(160),
    healthy: z.boolean(),
    detail: z.string().max(1000).optional()
  }).strict()).max(100)
}).strict();

export const HttpRequestInputSchema = z.object({
  companyId,
  operation: id,
  payload: z.record(z.unknown())
}).strict();

export const HttpRequestResultSchema = z.object({
  providerOperationId: z.string().min(1).max(500),
  responseStatus: z.number().int().min(200).max(299),
  responseBodyHash: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: isoDateTime
}).strict();

export const BrowserExecutionInputSchema = z.object({
  companyId,
  instruction: z.string().min(1).max(20_000),
  allowedOrigins: z.array(z.string().url()).min(1).max(20),
  timeoutSeconds: z.number().int().positive().max(900)
}).strict();

export const BrowserExecutionResultSchema = z.object({
  executionId: id,
  status: z.enum(["succeeded", "failed", "cancelled"]),
  artifactRefs: z.array(z.string().min(1).max(1024)).max(100).default([]),
  observedAt: isoDateTime
}).strict();

export const CodeExecutionInputSchema = z.object({
  companyId,
  runtime: z.enum(["node", "python", "shell"]),
  entrypoint: z.string().min(1).max(1024),
  input: z.record(z.unknown()).default({}),
  timeoutSeconds: z.number().int().positive().max(900)
}).strict();

export const CodeExecutionResultSchema = z.object({
  executionId: id,
  status: z.enum(["succeeded", "failed", "cancelled"]),
  exitCode: z.number().int(),
  outputHash: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: isoDateTime
}).strict();

export const ScheduledWorkerInputSchema = z.object({
  companyId,
  operation: id,
  scheduledAt: isoDateTime,
  payload: z.record(z.unknown())
}).strict();

export const ScheduledWorkerResultSchema = z.object({
  scheduleId: id,
  status: z.enum(["scheduled", "executed", "cancelled", "failed"]),
  observedAt: isoDateTime
}).strict();

export const capabilitySchemaRegistry = {
  "revenue.read": {
    input: RevenueReadInputSchema,
    output: RevenueSummarySchema
  },
  "email.send": {
    input: EmailSendInputSchema,
    output: EmailSendResultSchema
  },
  "repository.inspect": {
    input: RepositoryInspectInputSchema,
    output: RepositoryInspectionSchema
  },
  "production.deploy": {
    input: ProductionDeployInputSchema,
    output: DeploymentResultSchema
  },
  "compute.cpu.light": {
    input: ComputeWorkloadInputSchema,
    output: ComputeWorkloadResultSchema
  },
  "compute.gpu.inference": {
    input: GpuInferenceInputSchema,
    output: GpuInferenceResultSchema
  },
  "storage.backup": {
    input: StorageBackupInputSchema,
    output: StorageBackupResultSchema
  },
  "resource.health.read": {
    input: ResourceHealthReadInputSchema,
    output: ResourceHealthSummarySchema
  },
  "http.request": {
    input: HttpRequestInputSchema,
    output: HttpRequestResultSchema
  },
  "browser.execution": {
    input: BrowserExecutionInputSchema,
    output: BrowserExecutionResultSchema
  },
  "code.execution": {
    input: CodeExecutionInputSchema,
    output: CodeExecutionResultSchema
  },
  "scheduled.worker": {
    input: ScheduledWorkerInputSchema,
    output: ScheduledWorkerResultSchema
  }
} as const;

export type CapabilityName = keyof typeof capabilitySchemaRegistry;
