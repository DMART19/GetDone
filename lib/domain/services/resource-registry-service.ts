import { createAuditEvent } from "@/lib/domain/audit";
import { commandFingerprint, type AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { claimIdempotency } from "@/lib/domain/idempotency";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import {
  executeTransitionCommand,
  type EntityStore
} from "@/lib/domain/services/common";
import type {
  Resource,
  ResourceRegistryReadModel,
  ResourceState,
  ResourceType
} from "@/lib/domain/resources";

export interface ResourceRegistryStore extends EntityStore<Resource> {
  create(resource: Resource): Promise<void>;
  getReadModel(resourceId: string): Promise<ResourceRegistryReadModel | null>;
  listByCompany(portfolioId: string, companyId: string): Promise<readonly ResourceRegistryReadModel[]>;
}

export interface ResourceRegistryStores {
  resources: ResourceRegistryStore;
}

export interface DiscoverResourceInput {
  id: string;
  type: ResourceType;
  providerId?: string;
  poolId?: string;
  environmentPermissions?: Resource["environmentPermissions"];
  region?: string;
  architecture?: string;
  discoveredAt?: string;
}

function timestamp(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

function hasFreshVerifiedIdentity(model: ResourceRegistryReadModel, now: number) {
  return model.identityEvidence.some((item) =>
    item.status === "verified"
    && Boolean(item.verifiedAt)
    && (!item.expiresAt || timestamp(item.expiresAt, "identity expiry") > now)
  );
}

function hasFreshAcceptedTrust(model: ResourceRegistryReadModel, now: number) {
  return model.trustEvidence.some((item) =>
    item.status === "accepted"
    && item.classification !== "untrusted"
    && (!item.expiresAt || timestamp(item.expiresAt, "trust expiry") > now)
  );
}

function latestFreshHealth(model: ResourceRegistryReadModel, now: number) {
  return [...model.healthRecords]
    .filter((item) => timestamp(item.observedAt, "health observedAt") <= now)
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))
    .find((item) => timestamp(item.expiresAt, "health expiresAt") > now);
}

export function assertResourceReadyEligibility(
  model: ResourceRegistryReadModel,
  now = Date.now()
) {
  const resource = model.resource;

  if (!hasFreshVerifiedIdentity(model, now)) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Resource lacks fresh verified identity evidence");
  }
  if (resource.trustClass === "untrusted" || !hasFreshAcceptedTrust(model, now)) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Resource lacks accepted trust classification");
  }
  if (
    model.capabilityBindings.length === 0
    || model.capabilityBindings.some((binding) =>
      binding.status !== "validated" || !binding.adapterBindingId
    )
  ) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Resource capabilities are not fully validated");
  }

  const health = latestFreshHealth(model, now);
  if (!health || health.state !== "healthy" || !health.healthMethod) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Resource lacks fresh healthy status and health method");
  }
  if (resource.environmentPermissions.length === 0) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Resource has no authorized environment");
  }
  if (resource.policyBindingIds.length === 0) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Resource has no policy binding");
  }
  if (
    model.providerBindings.length === 0
    || !model.providerBindings.some((binding) =>
      binding.status === "active" && Boolean(binding.adapterBindingId)
    )
  ) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Resource has no active provider/adapter binding");
  }

  return model;
}

export class ResourceRegistryService {
  constructor(private readonly transactions: ControlPlaneTransactionManager<ResourceRegistryStores>) {}

  discover(input: DiscoverResourceInput, command: AuthoritativeCommandEnvelope) {
    if (!input.id) throw new ControlPlaneError("VALIDATION_FAILED", "Resource identity is required");
    const discoveredAt = input.discoveredAt ?? new Date().toISOString();
    timestamp(discoveredAt, "discoveredAt");
    const fingerprint = commandFingerprint(command);

    return this.transactions.run(async (transaction) => {
      const claim = await claimIdempotency<Resource>(
        transaction.idempotency,
        command.idempotencyKey,
        fingerprint,
        new Date(discoveredAt)
      );
      if (claim.state === "COMPLETED" && claim.record.result) return claim.record.result;
      if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
        throw new ControlPlaneError("CONFLICT", "Resource discovery command is not retryable yet");
      }

      const resource: Resource = Object.freeze({
        id: input.id,
        portfolioId: command.scope.portfolioId,
        companyId: command.scope.companyId,
        type: input.type,
        providerId: input.providerId,
        poolId: input.poolId,
        state: "discovered",
        environmentPermissions: Object.freeze([...(input.environmentPermissions ?? [])]),
        capabilityNames: Object.freeze([]),
        failureDomainIds: Object.freeze([]),
        credentialBindingIds: Object.freeze([]),
        policyBindingIds: Object.freeze([]),
        trustClass: "untrusted",
        dataClassesAllowed: Object.freeze(["public"]),
        region: input.region,
        architecture: input.architecture,
        createdAt: discoveredAt,
        updatedAt: discoveredAt,
        version: 1
      });

      await transaction.stores.resources.create(resource);
      await transaction.audit.append(createAuditEvent({
        correlationId: command.correlationId,
        eventType: "resource.discovered",
        actor: command.actor,
        scope: {
          userId: command.scope.userId,
          portfolioId: command.scope.portfolioId,
          companyId: command.scope.companyId,
          resourceId: resource.id
        },
        environment: command.environment,
        entityType: "resource",
        entityId: resource.id,
        newState: "discovered",
        provenance: command.provenance,
        metadata: {
          resourceType: resource.type,
          providerId: resource.providerId ?? null
        }
      }));
      await transaction.idempotency.complete(
        command.idempotencyKey,
        fingerprint,
        resource,
        discoveredAt
      );
      return resource;
    });
  }

  list(command: AuthoritativeCommandEnvelope) {
    return this.transactions.run(async (transaction) => {
      const models = await transaction.stores.resources.listByCompany(
        command.scope.portfolioId,
        command.scope.companyId
      );
      for (const model of models) {
        if (
          model.resource.portfolioId !== command.scope.portfolioId
          || model.resource.companyId !== command.scope.companyId
        ) {
          throw new ControlPlaneError("FORBIDDEN", "Resource registry returned cross-tenant data");
        }
      }
      return models;
    });
  }

  private transition(
    id: string,
    to: ResourceState,
    command: AuthoritativeCommandEnvelope,
    options: {
      beforeTransition?: Parameters<typeof executeTransitionCommand<Resource, ResourceRegistryStores>>[0]["beforeTransition"];
      reason?: string;
    } = {}
  ) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.resources,
      entityType: "resource",
      entityId: id,
      to,
      command,
      triggeringEvent: `resource-${to}`,
      beforeTransition: options.beforeTransition,
      metadata: () => ({ reason: options.reason ?? null })
    });
  }

  beginEnrollment(id: string, command: AuthoritativeCommandEnvelope) {
    return this.transition(id, "enrolling", command);
  }

  beginProfiling(id: string, command: AuthoritativeCommandEnvelope) {
    return this.transition(id, "profiling", command);
  }

  beginValidation(id: string, command: AuthoritativeCommandEnvelope) {
    return this.transition(id, "validating", command);
  }

  markReady(id: string, command: AuthoritativeCommandEnvelope, now = Date.now()) {
    return this.transition(id, "ready", command, {
      beforeTransition: async (_current, transaction) => {
        const model = await transaction.stores.resources.getReadModel(id);
        if (!model) throw new ControlPlaneError("NOT_FOUND", "Resource registry read model was not found");
        assertResourceReadyEligibility(model, now);
      }
    });
  }

  degrade(id: string, command: AuthoritativeCommandEnvelope, reason: string) {
    return this.transition(id, "degraded", command, { reason });
  }

  saturate(id: string, command: AuthoritativeCommandEnvelope, reason: string) {
    return this.transition(id, "saturated", command, { reason });
  }

  drain(id: string, command: AuthoritativeCommandEnvelope, reason: string) {
    return this.transition(id, "draining", command, { reason });
  }

  markUnreachable(id: string, command: AuthoritativeCommandEnvelope, reason: string) {
    return this.transition(id, "unreachable", command, { reason });
  }

  fail(id: string, command: AuthoritativeCommandEnvelope, reason: string) {
    return this.transition(id, "failed", command, { reason });
  }

  quarantine(id: string, command: AuthoritativeCommandEnvelope, reason: string) {
    return this.transition(id, "quarantined", command, { reason });
  }

  beginMaintenance(id: string, command: AuthoritativeCommandEnvelope, reason: string) {
    return this.transition(id, "maintenance", command, { reason });
  }

  disable(id: string, command: AuthoritativeCommandEnvelope, reason: string) {
    return this.transition(id, "disabled", command, { reason });
  }
}
