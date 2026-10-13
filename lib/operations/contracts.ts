import { z } from "zod";

export const operationScopeSchema = z.object({
  userId: z.string().min(1), portfolioId: z.string().min(1), companyId: z.string().min(1),
  environment: z.enum(["development", "staging", "production"]), resourceId: z.string().optional()
}).strict();
export type OperationScope = z.infer<typeof operationScopeSchema>;
export const sensitivitySchema = z.enum(["public", "internal", "customer", "sensitive"]);
const timestamp = z.string().datetime({ offset: true });
export const evidenceSchema = z.object({
  evidenceId: z.string().min(1), portfolioId: z.string().min(1), companyId: z.string().min(1),
  environment: operationScopeSchema.shape.environment, topic: z.string().min(1).max(100),
  sourceType: z.string().min(1).max(100), sourceRef: z.string().min(1).max(500),
  observedAt: timestamp, freshUntil: timestamp, sensitivity: sensitivitySchema,
  summary: z.string().max(4000), facts: z.record(z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()])),
  deepLink: z.string().max(1000).optional(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  confidence: z.number().min(0).max(1),
  authorization: z.object({ connectionId: z.string().min(1), resourceId: z.string().min(1),
    grantedUserIds: z.array(z.string().min(1)).min(1), provenanceRef: z.string().min(1),
    authorizedAt: timestamp }).strict(),
  providerMetadata: z.record(z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()])).optional()
}).strict().refine(e => Date.parse(e.freshUntil) > Date.parse(e.observedAt), { message: "Invalid evidence freshness interval" });
export type NormalizedEvidence = z.infer<typeof evidenceSchema>;

export const workflowNames = ["github_repository_health", "deployment_health", "github_create_branch"] as const;
export type NarrowWorkflow = typeof workflowNames[number];
export const connectionSchema = z.object({
  id: z.string().min(1), portfolioId: z.string().min(1), companyId: z.string().min(1),
  environment: operationScopeSchema.shape.environment, provider: z.enum(["github", "deployment", "revenue"]),
  status: z.enum(["healthy", "degraded", "broken", "disabled", "blocked"]),
  resources: z.array(z.string().min(1)).max(200), grantedUserIds: z.array(z.string().min(1)),
  workflows: z.array(z.enum(workflowNames)), expiresAt: timestamp.optional(),
  updatedAt: timestamp, sensitivity: sensitivitySchema.default("internal")
}).strict();
export type OperationalConnection = z.infer<typeof connectionSchema>;
export const inboxSchema = z.object({
  id: z.string().min(1), portfolioId: z.string().min(1), companyId: z.string().min(1),
  environment: operationScopeSchema.shape.environment, userId: z.string().min(1),
  objectType: z.string().min(1), objectId: z.string().min(1),
  kind: z.enum(["approval", "owner-input", "ambiguity", "job", "objective", "connection", "recommendation"]),
  state: z.enum(["open", "resolved"]), summary: z.string().max(1000),
  urgency: z.number().min(0).max(1), impact: z.number().min(0).max(1), confidence: z.number().min(0).max(1),
  createdAt: timestamp, updatedAt: timestamp, sensitivity: sensitivitySchema.default("internal"),
  nextAction: z.object({ label: z.string().min(1).max(200), href: z.string().min(1).max(1000) }).strict()
}).strict();
export type OwnerInboxItem = z.infer<typeof inboxSchema>;
