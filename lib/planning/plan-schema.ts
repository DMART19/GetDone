import { z } from "zod";
import type { GetDoneEnvironment } from "@/lib/control-plane/request-context";

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/);
const isoDateTime = z.string().datetime({ offset: true });
const dataClass = z.enum(["public", "internal", "customer", "sensitive"]);
const environment = z.enum(["development", "staging", "production"]);
const riskLevel = z.enum(["low", "medium", "high", "critical"]);
const reliabilityTier = z.enum(["best-effort", "standard", "high"]);
const interruptionClass = z.enum(["none", "brief", "preemptible"]);

export const PlanSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("objective"),
    objectiveId: id
  }).strict(),
  z.object({
    type: z.literal("investigation"),
    investigationId: id
  }).strict(),
  z.object({
    type: z.literal("owner-request"),
    requestId: id
  }).strict()
]);

export const PlanScopeSchema = z.object({
  portfolioId: id,
  companyId: id,
  environment,
  dataClass
}).strict();

export const EvidenceReferenceSchema = z.object({
  id,
  kind: z.enum(["fact", "signal", "investigation", "research", "outcome", "owner-input", "policy"]),
  source: z.string().min(1).max(300),
  observedAt: isoDateTime.optional()
}).strict();

export const PlanRiskSchema = z.object({
  level: riskLevel,
  summary: z.string().min(1).max(2000),
  blastRadius: z.enum(["single-object", "company", "portfolio", "infrastructure"])
}).strict();

export const RollbackSchema = z.object({
  strategy: z.enum(["none", "compensating-action", "restore", "manual"]),
  description: z.string().min(1).max(4000).optional(),
  cancellationAllowed: z.boolean()
}).strict().superRefine((value, ctx) => {
  if (value.strategy !== "none" && !value.description) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["description"],
      message: "Rollback description is required when a rollback strategy is configured"
    });
  }
});

export const VerificationRequirementSchema = z.object({
  id,
  description: z.string().min(1).max(2000),
  kind: z.enum(["capability-output", "metric", "state", "independent-check"]),
  required: z.boolean().default(true)
}).strict();

export const PlanPreconditionSchema = z.object({
  key: z.string().min(1).max(200),
  operator: z.enum(["equals", "not-equals", "min", "max", "exists"]),
  expected: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]).optional()
}).strict();

export const PlanEffectSchema = z.object({
  key: z.string().min(1).max(200),
  operation: z.enum(["set", "increase", "decrease", "enable", "disable"]),
  value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]).optional()
}).strict();

export const ResourceRequirementEnvelopeSchema = z.object({
  compute: z.object({
    cpuCores: z.number().positive().max(512).optional(),
    memoryMb: z.number().int().positive().max(2_097_152).optional(),
    gpuCount: z.number().int().positive().max(64).optional(),
    gpuClass: z.string().min(1).max(160).optional(),
    minVramMb: z.number().int().positive().max(1_048_576).optional(),
    architecture: z.string().min(1).max(160).optional()
  }).strict().optional(),
  execution: z.object({
    environment,
    deadline: isoDateTime.optional(),
    priority: z.number().int().min(0).max(100),
    expectedDurationSeconds: z.number().int().positive().max(2_592_000).optional(),
    checkpointable: z.boolean(),
    retryable: z.boolean()
  }).strict(),
  reliability: z.object({
    minimumTier: reliabilityTier,
    fallbackRequired: z.boolean(),
    maxInterruptionClass: interruptionClass
  }).strict(),
  data: z.object({
    classification: dataClass,
    customerData: z.boolean(),
    allowedRegions: z.array(z.string().min(1).max(160)).max(100).default([]),
    localityPreference: z.string().min(1).max(300).optional()
  }).strict(),
  economics: z.object({
    maxJobCostCents: z.number().int().nonnegative().optional(),
    budgetBindingId: id.optional()
  }).strict(),
  credentialBindingRequired: z.boolean().default(false)
}).strict();

export const CapabilityRequestSchema = z.object({
  capability: z.string().min(1).max(200),
  input: z.unknown()
}).strict();

export const PlanStepSchema = z.object({
  id,
  title: z.string().min(1).max(300),
  reason: z.string().min(1).max(4000),
  evidenceIds: z.array(id).max(200).default([]),
  dependsOn: z.array(id).max(100).default([]),
  conflictsWith: z.array(id).max(100).default([]),
  capabilityRequests: z.array(CapabilityRequestSchema).min(1).max(100),
  preconditions: z.array(PlanPreconditionSchema).max(100).default([]),
  effects: z.array(PlanEffectSchema).max(100).default([]),
  expectedOutcome: z.string().min(1).max(4000),
  estimatedCostCents: z.number().int().nonnegative(),
  risk: PlanRiskSchema,
  rollback: RollbackSchema,
  verificationRequirements: z.array(VerificationRequirementSchema).min(1).max(100),
  resourceRequirements: ResourceRequirementEnvelopeSchema
}).strict();

export const PlanProposalSchema = z.object({
  id,
  proposalVersion: z.number().int().positive(),
  scope: PlanScopeSchema,
  source: PlanSourceSchema,
  objective: z.object({
    id,
    metric: z.string().min(1).max(200),
    target: z.union([z.number().finite(), z.string().min(1).max(500)])
  }).strict().optional(),
  evidence: z.array(EvidenceReferenceSchema).max(500).default([]),
  assumptions: z.array(z.string().min(1).max(2000)).max(200).default([]),
  planDependencies: z.array(id).max(100).default([]),
  requestedCapabilities: z.array(z.string().min(1).max(200)).min(1).max(200),
  expectedOutcomes: z.array(z.object({
    metric: z.string().min(1).max(200),
    target: z.union([z.number().finite(), z.string().min(1).max(500)]),
    description: z.string().min(1).max(2000)
  }).strict()).min(1).max(100),
  estimatedCostCents: z.number().int().nonnegative(),
  risk: PlanRiskSchema,
  rollback: RollbackSchema,
  verificationRequirements: z.array(VerificationRequirementSchema).min(1).max(100),
  steps: z.array(PlanStepSchema).min(1).max(500),
  createdAt: isoDateTime
}).strict().superRefine((plan, ctx) => {
  if (plan.source.type === "objective" && (!plan.objective || plan.objective.id !== plan.source.objectiveId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["objective"],
      message: "Objective-sourced plans must include the matching objective"
    });
  }
});

export type PlanSource = z.infer<typeof PlanSourceSchema>;
export type PlanScope = z.infer<typeof PlanScopeSchema>;
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type PlanRisk = z.infer<typeof PlanRiskSchema>;
export type Rollback = z.infer<typeof RollbackSchema>;
export type VerificationRequirement = z.infer<typeof VerificationRequirementSchema>;
export type PlanPrecondition = z.infer<typeof PlanPreconditionSchema>;
export type PlanEffect = z.infer<typeof PlanEffectSchema>;
export type ResourceRequirementEnvelope = z.infer<typeof ResourceRequirementEnvelopeSchema>;
export type CapabilityRequest = z.infer<typeof CapabilityRequestSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanProposal = z.infer<typeof PlanProposalSchema>;

export function parsePlanProposal(value: unknown): PlanProposal {
  return PlanProposalSchema.parse(value);
}

export function planEnvironment(plan: PlanProposal): GetDoneEnvironment {
  return plan.scope.environment;
}
