import { authorizeRequest } from "@/lib/auth/guard";
import type { AuthAdapter, AuthSession } from "@/lib/auth/contracts";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { createCorrelationId } from "@/lib/control-plane/request-context";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import {
  resolveDecision,
  type AuthoritativeDecision
} from "@/lib/domain/decision-service";
import type { DecisionTransactionManager } from "@/lib/domain/decision-transaction";
import type { JobRecord } from "@/lib/domain/services/job-service";
import { ResourceRegistryService } from "@/lib/domain/services/resource-registry-service";
import type { VerificationRequestRecord } from "@/lib/domain/services/verification-service";
import type { Resource } from "@/lib/domain/resources";
import type {
  ControlApiApplicationAdapter,
  ControlApiHealth,
  ControlApiPrincipal,
  DecisionMutationInput,
  JobResultView,
  OwnerIntentInput,
  OwnerIntentRecord,
  ResourceEnrollmentInput
} from "@/lib/control-api/contracts";

export interface ControlApiScopeResolver {
  resolve(session: AuthSession, request: Request): Promise<TrustedExecutionScope>;
}

export interface ScopedReadStore<T extends { id: string; portfolioId: string; companyId: string }> {
  listByScope(portfolioId: string, companyId: string): Promise<readonly T[]>;
  get(id: string): Promise<T | null>;
}

export interface OwnerIntentStore {
  create(record: OwnerIntentRecord, idempotencyKey: string): Promise<OwnerIntentRecord>;
}

export interface ServiceBackedControlApiDependencies {
  auth: AuthAdapter;
  scopes: ControlApiScopeResolver;
  intents: OwnerIntentStore;
  decisions: ScopedReadStore<AuthoritativeDecision>;
  decisionTransactions: DecisionTransactionManager;
  resources: ScopedReadStore<Resource>;
  resourceRegistry: ResourceRegistryService;
  jobs: ScopedReadStore<JobRecord>;
  verifications: ScopedReadStore<VerificationRequestRecord>;
  health: () => Promise<ControlApiHealth>;
  now?: () => Date;
}

function assertScopedEntity(
  principal: ControlApiPrincipal,
  entity: { portfolioId: string; companyId: string } | null
) {
  if (!entity) return null;
  if (
    entity.portfolioId !== principal.scope.portfolioId
    || entity.companyId !== principal.scope.companyId
  ) {
    throw new ControlPlaneError("NOT_FOUND", "Scoped control-plane entity was not found");
  }
  return entity;
}

export class ServiceBackedControlApiAdapter implements ControlApiApplicationAdapter {
  private readonly now: () => Date;

  constructor(private readonly deps: ServiceBackedControlApiDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async authenticate(request: Request): Promise<ControlApiPrincipal> {
    const { session } = await authorizeRequest(this.deps.auth, request, "session");
    const scope = await this.deps.scopes.resolve(session, request);
    if (
      scope.userId !== session.userId
      || !scope.portfolioId
      || !scope.companyId
    ) {
      throw new ControlPlaneError("FORBIDDEN", "Trusted Control API scope is incomplete");
    }
    return {
      actor: { type: "user", id: session.userId },
      scope,
      sessionId: session.sessionId
    };
  }

  health() {
    return this.deps.health();
  }

  async submitOwnerIntent(
    principal: ControlApiPrincipal,
    input: OwnerIntentInput,
    idempotencyKey: string
  ) {
    const record: OwnerIntentRecord = Object.freeze({
      id: crypto.randomUUID(),
      portfolioId: principal.scope.portfolioId,
      companyId: principal.scope.companyId,
      environment: principal.scope.environment,
      userId: principal.scope.userId,
      message: input.message,
      channel: input.channel ?? "chat",
      status: "accepted",
      receivedAt: this.now().toISOString()
    });
    return this.deps.intents.create(record, idempotencyKey);
  }

  listDecisions(principal: ControlApiPrincipal) {
    return this.deps.decisions.listByScope(
      principal.scope.portfolioId,
      principal.scope.companyId
    );
  }

  async getDecision(principal: ControlApiPrincipal, decisionId: string) {
    return assertScopedEntity(principal, await this.deps.decisions.get(decisionId));
  }

  mutateDecision(principal: ControlApiPrincipal, input: DecisionMutationInput) {
    const correlationId = createCorrelationId();
    const command = createCommandEnvelope({
      commandId: crypto.randomUUID(),
      actor: principal.actor,
      scope: principal.scope,
      correlationId,
      environment: principal.scope.environment,
      idempotencyKey: input.idempotencyKey,
      provenance: "control-api:decision-mutation",
      requestedMutation: {
        type: "decision.resolve" as const,
        decisionId: input.decisionId,
        action: input.action
      }
    });

    return resolveDecision({
      command,
      transactionManager: this.deps.decisionTransactions,
      decisionId: input.decisionId,
      action: input.action,
      now: this.now
    });
  }

  listResources(principal: ControlApiPrincipal) {
    return this.deps.resources.listByScope(
      principal.scope.portfolioId,
      principal.scope.companyId
    );
  }

  async getResource(principal: ControlApiPrincipal, resourceId: string) {
    return assertScopedEntity(principal, await this.deps.resources.get(resourceId));
  }

  enrollResource(principal: ControlApiPrincipal, input: ResourceEnrollmentInput) {
    const correlationId = createCorrelationId();
    const command = createCommandEnvelope({
      commandId: crypto.randomUUID(),
      actor: principal.actor,
      scope: principal.scope,
      correlationId,
      environment: principal.scope.environment,
      idempotencyKey: input.idempotencyKey,
      provenance: "control-api:resource-enrollment",
      requestedMutation: {
        type: "resource.discover",
        resourceId: input.id
      }
    });

    return this.deps.resourceRegistry.discover({
      id: input.id,
      type: input.type,
      providerId: input.providerId,
      poolId: input.poolId,
      environmentPermissions: [principal.scope.environment],
      capabilityNames: input.capabilityNames,
      failureDomainIds: input.failureDomainIds,
      credentialBindingIds: input.credentialBindingIds,
      policyBindingIds: input.policyBindingIds,
      dataClassesAllowed: ["public"],
      region: input.region,
      architecture: input.architecture,
      discoveredAt: this.now().toISOString()
    }, command);
  }

  listJobs(principal: ControlApiPrincipal) {
    return this.deps.jobs.listByScope(
      principal.scope.portfolioId,
      principal.scope.companyId
    );
  }

  async getJob(principal: ControlApiPrincipal, jobId: string) {
    return assertScopedEntity(principal, await this.deps.jobs.get(jobId));
  }

  async getJobResult(principal: ControlApiPrincipal, jobId: string): Promise<JobResultView | null> {
    const job = await this.getJob(principal, jobId);
    if (!job) return null;
    return Object.freeze({
      jobId: job.id,
      state: job.state,
      verificationEvidenceIds: [...job.verificationEvidenceIds],
      verificationReceiptId: job.verificationReceiptId,
      verificationReceiptHash: job.verificationReceiptHash,
      verifiedCompletionFactId: job.verifiedCompletionFactId,
      verifiedCompletionFactHash: job.verifiedCompletionFactHash,
      failureReason: job.failureReason
    });
  }

  listVerifications(principal: ControlApiPrincipal) {
    return this.deps.verifications.listByScope(
      principal.scope.portfolioId,
      principal.scope.companyId
    );
  }

  async getVerification(principal: ControlApiPrincipal, verificationId: string) {
    return assertScopedEntity(
      principal,
      await this.deps.verifications.get(verificationId)
    );
  }
}
