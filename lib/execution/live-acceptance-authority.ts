import { createAuthorizationConsumptionRecord, type AuthorizationGrant } from "@/lib/authorization/grants";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { CAPABILITY_REGISTRY_HASH, CAPABILITY_REGISTRY_VERSION, requireEnabledCapability } from "@/lib/domain/capabilities";
import { CURRENT_POLICY_REGISTRY_HASH, CURRENT_POLICY_VERSION } from "@/lib/domain/policy-registry";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { TaskRecord } from "@/lib/domain/services/task-service";
import type { CompanyIntegration } from "@/lib/integrations/contracts";
import { POLICY_ENGINE_VERSION, POLICY_RULES_HASH } from "@/lib/planning/policy-engine";
import { PostgresAuthorizationGrantStore, PostgresEntityStore } from "@/lib/persistence/postgres/authority-stores";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

export async function seedLiveAcceptanceAuthority(input: {
  db: PostgresTransactionalDatabase;
  id: string;
  taskId: string;
  correlationId: string;
  scope: { userId: string; portfolioId: string; companyId: string; environment: "staging" };
  capability: string;
  now: string;
  maxAttempts?: number;
}): Promise<JobRecord> {
  const capability = requireEnabledCapability(input.capability);
  const integrationId = `integration:${input.id}`;
  const integrationBase = {
    id: integrationId,
    portfolioId: input.scope.portfolioId,
    companyId: input.scope.companyId,
    environment: input.scope.environment,
    kind: (input.capability === "http.request" ? "rest-api" : input.capability.startsWith("gmail.") ? "gmail" : input.capability.startsWith("slack.") ? "slack" : input.capability.startsWith("github.") || input.capability.startsWith("repository.") ? "github" : "webhook") as CompanyIntegration["kind"],
    provider: "live-acceptance",
    displayName: "Live acceptance authority",
    adapterId: capability.adapterBinding,
    adapterVersion: "acceptance-v1",
    accountIdentity: "acceptance",
    supportedCapabilities: Object.freeze([input.capability]),
    readScopes: Object.freeze(["acceptance"]),
    writeScopes: Object.freeze(["acceptance"]),
    state: "connected" as const,
    health: Object.freeze({ status: "healthy" as const, observedAt: input.now }),
    rateLimits: Object.freeze({}),
    policies: Object.freeze([]),
    metadata: Object.freeze({ acceptance: true }),
    mock: false,
    createdAt: input.now,
    updatedAt: input.now
  };
  const integration: CompanyIntegration = Object.freeze({
    ...integrationBase,
    recordHash: sha256Hex(integrationBase)
  });
  await input.db.query(
    `INSERT INTO control_plane_entities(entity_type,id,portfolio_id,company_id,version,updated_at,payload)
     VALUES('integration',$1,$2,$3,1,$4,$5::jsonb)`,
    [integration.id, integration.portfolioId, integration.companyId, integration.updatedAt, JSON.stringify(integration)]
  );

  const issuedAt = new Date(Date.parse(input.now) - 60_000).toISOString();
  const expiresAt = new Date(Date.parse(input.now) + 60 * 60_000).toISOString();
  const grantBase = {
    id: `grant-${input.id}`,
    status: "active" as const,
    disposition: "AUTO" as const,
    scope: Object.freeze({ ...input.scope }),
    planId: `plan-${input.id}`,
    planVersion: 1,
    planHash: sha256Hex({ id: input.id, type: "plan" }),
    stepId: `step-${input.id}`,
    stepHash: sha256Hex({ id: input.id, type: "step" }),
    capabilityNames: Object.freeze([input.capability]),
    integrationId,
    executionLimits: Object.freeze({
      environment: input.scope.environment,
      expectedDurationSeconds: 300,
      retryable: true,
      maxJobCostCents: 100
    }),
    validationReceiptId: `validation-${input.id}`,
    validationReceiptHash: sha256Hex({ id: input.id, type: "validation" }),
    policySnapshotId: `policy-${input.id}`,
    policySnapshotHash: sha256Hex({ id: input.id, type: "policy" }),
    policyVersion: CURRENT_POLICY_VERSION,
    policyRegistryHash: CURRENT_POLICY_REGISTRY_HASH,
    policyEngineVersion: POLICY_ENGINE_VERSION,
    policyRulesHash: POLICY_RULES_HASH,
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
    capabilityRegistryHash: CAPABILITY_REGISTRY_HASH,
    actor: Object.freeze({ type: "system" as const, id: "live-acceptance" }),
    issuedAt,
    expiresAt
  };
  const grant: AuthorizationGrant = Object.freeze({ ...grantBase, grantHash: sha256Hex(grantBase) });
  const grants = new PostgresAuthorizationGrantStore(input.db);
  await grants.insert(grant);
  const consumption = createAuthorizationConsumptionRecord({
    id: `authorization-consumption:${grant.id}`,
    grant,
    consumerType: "task",
    consumerId: input.taskId,
    consumedAt: input.now
  });
  await grants.consume(consumption);

  const task: TaskRecord = Object.freeze({
    id: input.taskId,
    correlationId: input.correlationId,
    portfolioId: input.scope.portfolioId,
    companyId: input.scope.companyId,
    state: "queued",
    reason: "Live acceptance governed provider execution",
    evidenceIds: Object.freeze([]),
    capabilityRequirements: Object.freeze([input.capability]),
    authorizationLineage: Object.freeze([grant.id]),
    authorizationGrantId: grant.id,
    authorizationGrantHash: grant.grantHash,
    authorizationConsumption: consumption,
    verificationEvidenceIds: Object.freeze([]),
    version: 1,
    updatedAt: input.now
  });
  await new PostgresEntityStore<TaskRecord>(input.db, "task").insert(task);

  const job: JobRecord = Object.freeze({
    id: input.id,
    correlationId: input.correlationId,
    portfolioId: input.scope.portfolioId,
    companyId: input.scope.companyId,
    state: "queued",
    taskId: input.taskId,
    attempt: 0,
    maxAttempts: input.maxAttempts ?? 5,
    authorizationGrantId: grant.id,
    authorizationGrantHash: grant.grantHash,
    authorizationConsumption: consumption,
    verificationEvidenceIds: Object.freeze([]),
    version: 2,
    updatedAt: input.now
  });
  await new PostgresEntityStore<JobRecord>(input.db, "job").insert(job);
  return job;
}
