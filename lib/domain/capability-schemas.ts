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

export const WebhookSendInputSchema = z.object({
  companyId,
  operation: id,
  payload: z.record(z.unknown())
}).strict();

export const WebhookSendResultSchema = z.object({
  providerOperationId: z.string().min(1).max(500),
  responseStatus: z.number().int().min(200).max(299),
  responseBodyHash: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: isoDateTime
}).strict();

export const SlackMessageSendInputSchema = z.object({
  companyId,
  channelId: z.string().min(1).max(200),
  text: z.string().min(1).max(40_000),
  threadTs: z.string().regex(/^\d+\.\d+$/).optional()
}).strict();

export const SlackMessageSendResultSchema = z.object({
  channelId: z.string().min(1).max(200),
  messageTs: z.string().regex(/^\d+\.\d+$/),
  providerReference: z.string().min(1).max(500),
  acceptedAt: isoDateTime
}).strict();

const crmScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const crmProperties = z.record(z.string().min(1).max(160), crmScalar);

export const CrmRecordReadInputSchema = z.object({
  companyId,
  connectionId: id,
  objectType: z.enum(["contact", "company", "deal"]),
  recordId: z.string().min(1).max(300)
}).strict();

export const CrmRecordWriteInputSchema = z.object({
  companyId,
  connectionId: id,
  objectType: z.enum(["contact", "company", "deal"]),
  operation: z.enum(["create", "update"]),
  recordId: z.string().min(1).max(300).optional(),
  properties: crmProperties.refine((value) => Object.keys(value).length > 0, {
    message: "CRM mutation properties cannot be empty"
  })
}).strict().superRefine((value, ctx) => {
  if (value.operation === "update" && !value.recordId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recordId"],
      message: "CRM update requires recordId"
    });
  }
  if (value.operation === "create" && value.recordId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recordId"],
      message: "CRM create recordId is provider-assigned"
    });
  }
});

export const CrmRecordResultSchema = z.object({
  objectType: z.enum(["contact", "company", "deal"]),
  recordId: z.string().min(1).max(300),
  properties: crmProperties,
  observedAt: isoDateTime
}).strict();

export const CrmMutationAcceptedResultSchema = z.object({
  objectType: z.enum(["contact", "company", "deal"]),
  recordId: z.string().min(1).max(300),
  providerAccepted: z.literal(true),
  acceptedAt: isoDateTime
}).strict();

const githubBranch = z.string().min(1).max(255).regex(/^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]+$/);
const githubPath = z.string().min(1).max(1024).refine(
  (value) => !value.startsWith("/") && !value.split("/").includes("..") && !value.includes("\\"),
  { message: "GitHub path must be repository-relative and traversal-free" }
);

export const GithubRepositoryReadInputSchema = z.object({
  companyId,
  connectionId: id,
  repository,
  operation: z.enum(["repository", "branch", "file", "pull-request", "issue", "checks"]),
  branch: githubBranch.optional(),
  path: githubPath.optional(),
  number: z.number().int().positive().optional(),
  ref: z.string().min(1).max(255).optional()
}).strict();

export const GithubRepositoryReadResultSchema = z.object({
  repository,
  operation: z.enum(["repository", "branch", "file", "pull-request", "issue", "checks"]),
  data: z.unknown(),
  dataHash: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: isoDateTime
}).strict();

export const GithubBranchCreateInputSchema = z.object({
  companyId,
  connectionId: id,
  repository,
  branch: githubBranch,
  fromRef: z.string().min(1).max(255)
}).strict();

export const GithubFileChangeSchema = z.object({
  path: githubPath,
  operation: z.enum(["upsert", "delete"]),
  content: z.string().max(1_000_000).optional()
}).strict().superRefine((value, ctx) => {
  if (value.operation === "upsert" && value.content === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: "GitHub upsert requires content"
    });
  }
  if (value.operation === "delete" && value.content !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: "GitHub delete must not include content"
    });
  }
});

export const GithubCommitCreateInputSchema = z.object({
  companyId,
  connectionId: id,
  repository,
  branch: githubBranch,
  message: z.string().min(1).max(1000),
  files: z.array(GithubFileChangeSchema).min(1).max(100)
}).strict();

export const GithubPullRequestWriteInputSchema = z.object({
  companyId,
  connectionId: id,
  repository,
  operation: z.enum(["create", "update"]),
  number: z.number().int().positive().optional(),
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(100_000).optional(),
  head: githubBranch.optional(),
  base: githubBranch.optional(),
  draft: z.boolean().optional(),
  state: z.enum(["open", "closed"]).optional()
}).strict().superRefine((value, ctx) => {
  if (value.operation === "create" && (!value.title || !value.head || !value.base)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "GitHub PR create requires title, head, and base"
    });
  }
  if (value.operation === "update" && !value.number) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["number"],
      message: "GitHub PR update requires number"
    });
  }
});

export const GithubIssueWriteInputSchema = z.object({
  companyId,
  connectionId: id,
  repository,
  operation: z.enum(["create", "update"]),
  number: z.number().int().positive().optional(),
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(100_000).optional(),
  state: z.enum(["open", "closed"]).optional(),
  labels: z.array(z.string().min(1).max(100)).max(100).optional()
}).strict().superRefine((value, ctx) => {
  if (value.operation === "create" && !value.title) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["title"],
      message: "GitHub issue create requires title"
    });
  }
  if (value.operation === "update" && !value.number) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["number"],
      message: "GitHub issue update requires number"
    });
  }
});

export const GithubPullRequestMergeInputSchema = z.object({
  companyId,
  connectionId: id,
  repository,
  number: z.number().int().positive(),
  method: z.enum(["merge", "squash", "rebase"]).default("merge"),
  commitTitle: z.string().min(1).max(500).optional(),
  commitMessage: z.string().max(10_000).optional()
}).strict();

export const GithubMutationAcceptedResultSchema = z.object({
  repository,
  operation: z.string().min(1).max(80),
  providerAccepted: z.literal(true),
  providerReference: z.string().min(1).max(500),
  acceptedAt: isoDateTime
}).strict();

export const AnalyticsIngestReadInputSchema = z.object({
  companyId,
  sourceId: id,
  limit: z.number().int().positive().max(500).default(100)
}).strict();

export const AnalyticsEvidenceRecordSchema = z.object({
  externalId: z.string().min(1).max(500),
  sourceUpdatedAt: isoDateTime,
  observedAt: isoDateTime,
  fresh: z.boolean(),
  dedupeKey: z.string().regex(/^[a-f0-9]{64}$/),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.record(z.unknown()),
  provenance: z.object({
    sourceId: id,
    sourceUrlHash: z.string().regex(/^[a-f0-9]{64}$/),
    cursorHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    providerBatchHash: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict(),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export const AnalyticsIngestReadResultSchema = z.object({
  sourceId: id,
  checkpointBefore: z.string().max(2000).optional(),
  nextCursor: z.string().max(2000).optional(),
  records: z.array(AnalyticsEvidenceRecordSchema).max(500),
  batchHash: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: isoDateTime
}).strict();

const offsetDateTime = z.string().datetime({ offset: true });
const ianaTimeZone = z.string().min(1).max(120).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}, { message: "Timezone must be a valid IANA timezone" });

const calendarAttendee = z.object({
  email: z.string().email().max(320),
  displayName: z.string().min(1).max(200).optional(),
  optional: z.boolean().optional()
}).strict();

export const CalendarEventReadInputSchema = z.object({
  companyId,
  connectionId: id,
  calendarId: z.string().min(1).max(300),
  timeMin: offsetDateTime,
  timeMax: offsetDateTime,
  timeZone: ianaTimeZone,
  maxResults: z.number().int().positive().max(250).default(100)
}).strict();

export const CalendarEventMutationBaseSchema = z.object({
  companyId,
  connectionId: id,
  calendarId: z.string().min(1).max(300),
  title: z.string().min(1).max(1000),
  description: z.string().max(20_000).optional(),
  location: z.string().max(1000).optional(),
  startAt: offsetDateTime,
  endAt: offsetDateTime,
  timeZone: ianaTimeZone,
  attendees: z.array(calendarAttendee).max(250).optional(),
  busy: z.boolean().default(true)
}).strict();

export const CalendarEventCreateInputSchema = CalendarEventMutationBaseSchema.extend({
  conflictPolicy: z.enum(["reject", "allow"]).default("reject")
}).strict();

export const CalendarEventUpdateInputSchema = z.object({
  companyId,
  connectionId: id,
  calendarId: z.string().min(1).max(300),
  providerEventId: z.string().min(1).max(500),
  expectedRevision: z.string().min(1).max(500).optional(),
  title: z.string().min(1).max(1000).optional(),
  description: z.string().max(20_000).nullable().optional(),
  location: z.string().max(1000).nullable().optional(),
  startAt: offsetDateTime.optional(),
  endAt: offsetDateTime.optional(),
  timeZone: ianaTimeZone.optional(),
  attendees: z.array(calendarAttendee).max(250).optional(),
  busy: z.boolean().optional(),
  conflictPolicy: z.enum(["reject", "allow"]).default("reject")
}).strict().superRefine((value, ctx) => {
  const temporalCount = [value.startAt, value.endAt, value.timeZone].filter((item) => item !== undefined).length;
  if (temporalCount !== 0 && temporalCount !== 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Calendar update startAt, endAt, and timeZone must be supplied together"
    });
  }
  if (
    value.title === undefined
    && value.description === undefined
    && value.location === undefined
    && value.startAt === undefined
    && value.attendees === undefined
    && value.busy === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Calendar update requires at least one mutation field"
    });
  }
});

export const CalendarEventCancelInputSchema = z.object({
  companyId,
  connectionId: id,
  calendarId: z.string().min(1).max(300),
  providerEventId: z.string().min(1).max(500),
  expectedRevision: z.string().min(1).max(500).optional()
}).strict();

export const CalendarEventRecordSchema = z.object({
  providerEventId: z.string().min(1).max(500),
  calendarId: z.string().min(1).max(300),
  revision: z.string().min(1).max(500).optional(),
  status: z.enum(["confirmed", "cancelled", "tentative"]),
  title: z.string().max(1000),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  timeZone: ianaTimeZone,
  attendees: z.array(calendarAttendee).max(250),
  observedAt: isoDateTime
}).strict();

export const CalendarEventReadResultSchema = z.object({
  calendarId: z.string().min(1).max(300),
  timeMin: z.string().datetime(),
  timeMax: z.string().datetime(),
  timeZone: ianaTimeZone,
  events: z.array(CalendarEventRecordSchema).max(250),
  observedAt: isoDateTime,
  resultHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export const CalendarMutationAcceptedResultSchema = z.object({
  calendarId: z.string().min(1).max(300),
  providerEventId: z.string().min(1).max(500),
  operation: z.enum(["create", "update", "cancel"]),
  providerAccepted: z.literal(true),
  providerRevision: z.string().min(1).max(500).optional(),
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
  "webhook.send": {
    input: WebhookSendInputSchema,
    output: WebhookSendResultSchema
  },
  "slack.message.send": {
    input: SlackMessageSendInputSchema,
    output: SlackMessageSendResultSchema
  },
  "crm.record.read": {
    input: CrmRecordReadInputSchema,
    output: CrmRecordResultSchema
  },
  "crm.record.write": {
    input: CrmRecordWriteInputSchema,
    output: CrmMutationAcceptedResultSchema
  },
  "github.repository.read": {
    input: GithubRepositoryReadInputSchema,
    output: GithubRepositoryReadResultSchema
  },
  "github.branch.create": {
    input: GithubBranchCreateInputSchema,
    output: GithubMutationAcceptedResultSchema
  },
  "github.commit.create": {
    input: GithubCommitCreateInputSchema,
    output: GithubMutationAcceptedResultSchema
  },
  "github.protected-branch.commit": {
    input: GithubCommitCreateInputSchema,
    output: GithubMutationAcceptedResultSchema
  },
  "github.pull-request.write": {
    input: GithubPullRequestWriteInputSchema,
    output: GithubMutationAcceptedResultSchema
  },
  "github.issue.write": {
    input: GithubIssueWriteInputSchema,
    output: GithubMutationAcceptedResultSchema
  },
  "github.pull-request.merge": {
    input: GithubPullRequestMergeInputSchema,
    output: GithubMutationAcceptedResultSchema
  },
  "analytics.ingest.read": {
    input: AnalyticsIngestReadInputSchema,
    output: AnalyticsIngestReadResultSchema
  },
  "calendar.event.read": {
    input: CalendarEventReadInputSchema,
    output: CalendarEventReadResultSchema
  },
  "calendar.event.create": {
    input: CalendarEventCreateInputSchema,
    output: CalendarMutationAcceptedResultSchema
  },
  "calendar.event.update": {
    input: CalendarEventUpdateInputSchema,
    output: CalendarMutationAcceptedResultSchema
  },
  "calendar.event.cancel": {
    input: CalendarEventCancelInputSchema,
    output: CalendarMutationAcceptedResultSchema
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
