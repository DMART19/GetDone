import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { commandFingerprint } from "@/lib/control-plane/command-envelope";
import { createAuditEvent } from "@/lib/domain/audit";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import { claimIdempotency } from "@/lib/domain/idempotency";
import {
  buildResourceRegistryReadModel,
  evaluateResourceReadiness,
  type Resource,
  type ResourceCapabilityBinding,
  type ResourceCostProfile,
  type ResourceHealthRecord,
  type ResourceIdentityEvidence,
  type ResourceLocation,
  type ResourceProviderBinding,
  type ResourceRegistryEvidenceSnapshot,
  type ResourceRegistryReadModel,
  type ResourceTrustEvidence
} from "@/lib/domain/resources";
import {
  executeTransitionCommand,
  requireEntity,
  type EntityStore
} from "@/lib/domain/services/common";

export interface ResourceStore extends EntityStore<Resource> {
  create(record: Resource): Promise<void>;
  listByScope(portfolioId: string, companyId: string): Promise<readonly Resource[]>;
}

export interface ResourceEvidenceStore<T> {
  append(record: T): Promise<void>;
  listByResourceId(resourceId: string): Promise<readonly T[]>;
}

export interface ResourceRegistryStores {
  resources: ResourceStore;
  identities: ResourceEvidenceStore<ResourceIdentityEvidence>;
  trust: ResourceEvidenceStore<ResourceTrustEvidence>;
  health: ResourceEvidenceStore<ResourceHealthRecord>;
  capabilities: ResourceEvidenceStore<ResourceCapabilityBinding>;
  locations: ResourceEvidenceStore<ResourceLocation>;
  costs: ResourceEvidenceStore<ResourceCostProfile>;
  providers: ResourceEvidenceStore<ResourceProviderBinding>;
}

export interface DiscoverResourceInput {
  id: string;
  type: Resource["type"];
  providerId?: string;
  poolId?: string;
  environmentPermissions: Resource["environmentPermissions"];
  capabilityNames?: readonly string[];
  failureDomainIds?: readonly string[];
  credentialBindingIds?: readonly string[];
  policyBindingIds?: readonly string[];
  trustClass?: Resource["trustClass"];
  dataClassesAllowed?: Resource["dataClassesAllowed"];
  region?: string;
  architecture?: string;
  discoveredAt?: string;
}

type EvidenceRecord =
  | ResourceIdentityEvidence
  | ResourceTrustEvidence
  | ResourceHealthRecord
  | ResourceCapabilityBinding
  | ResourceLocation
  | ResourceCostProfile
  | ResourceProviderBinding;

async function evidenceSnapshot(
  stores: ResourceRegistryStores,
  resourceId: string
): Promise<ResourceRegistryEvidenceSnapshot> {
  const [identities, trust, health, capabilities, locations, costs, providers] =
    await Promise.all([
      stores.identities.listByResourceId(resourceId),
      stores.trust.listByResourceId(resourceId),
      stores.health.listByResourceId(resourceId),
      stores.capabilities.listByResourceId(resourceId),
      stores.locations.listByResourceId(resourceId),
      stores.costs.listByResourceId(resourceId),
      stores.providers.listByResourceId(resourceId)
    ]);

  return { identities, trust, health, capabilities, locations, costs, providers };
}

function assertEvidenceScope(resource: Resource, record: EvidenceRecord) {
  if (
    record.resourceId !== resource.id
    || record.portfolioId !== resource.portfolioId
    || record.companyId !== resource.companyId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Resource evidence does not match authoritative resource scope"
    );
  }
}

export class ResourceRegistryService {
  constructor(
    private readonly transactions: ControlPlaneTransactionManager<ResourceRegistryStores>
  ) {}

  async discover(
    input: DiscoverResourceInput,
    command: AuthoritativeCommandEnvelope
  ) {
    const discoveredAt = input.discoveredAt ?? new Date().toISOString();
    const fingerprint = commandFingerprint(command);

    return this.transactions.run(async (transaction) => {
      const claim = await claimIdempotency<Resource>(
        transaction.idempotency,
        command.idempotencyKey,
        fingerprint,
        new Date(discoveredAt)
      );
      if (claim.state === "COMPLETED" && claim.record.result) {
        return claim.record.result;
      }
      if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
        throw new ControlPlaneError(
          "CONFLICT",
          "Resource discovery command is already in progress or previously failed"
        );
      }

      const record: Resource = Object.freeze({
        id: input.id,
        portfolioId: command.scope.portfolioId,
        companyId: command.scope.companyId,
        type: input.type,
        providerId: input.providerId,
        poolId: input.poolId,
        state: "discovered",
        environmentPermissions: Object.freeze([...input.environmentPermissions]),
        capabilityNames: Object.freeze([...(input.capabilityNames ?? [])]),
        failureDomainIds: Object.freeze([...(input.failureDomainIds ?? [])]),
        credentialBindingIds: Object.freeze([...(input.credentialBindingIds ?? [])]),
        policyBindingIds: Object.freeze([...(input.policyBindingIds ?? [])]),
        identityEvidenceIds: Object.freeze([]),
        trustEvidenceIds: Object.freeze([]),
        healthRecordIds: Object.freeze([]),
        capabilityBindingIds: Object.freeze([]),
        locationIds: Object.freeze([]),
        costProfileIds: Object.freeze([]),
        providerBindingIds: Object.freeze([]),
        trustClass: input.trustClass ?? "untrusted",
        dataClassesAllowed: Object.freeze([...(input.dataClassesAllowed ?? ["public"])]),
        region: input.region,
        architecture: input.architecture,
        createdAt: discoveredAt,
        updatedAt: discoveredAt,
        version: 1
      });

      await transaction.stores.resources.create(record);
      await transaction.audit.append(createAuditEvent({
        correlationId: command.correlationId,
        eventType: "resource.discovered",
        actor: command.actor,
        scope: {
          userId: command.scope.userId,
          portfolioId: command.scope.portfolioId,
          companyId: command.scope.companyId,
          resourceId: record.id
        },
        environment: command.environment,
        entityType: "resource",
        entityId: record.id,
        newState: "discovered",
        provenance: command.provenance,
        metadata: {
          commandId: command.commandId,
          resourceType: record.type
        }
      }));

      await transaction.idempotency.complete(
        command.idempotencyKey,
        fingerprint,
        record,
        discoveredAt
      );
      return record;
    });
  }

  private async appendEvidence<T extends EvidenceRecord>(
    resourceId: string,
    record: T,
    command: AuthoritativeCommandEnvelope,
    eventType: string,
    selectStore: (stores: ResourceRegistryStores) => ResourceEvidenceStore<T>
  ) {
    const fingerprint = commandFingerprint(command);

    return this.transactions.run(async (transaction) => {
      const resource = await requireEntity(
        transaction.stores.resources,
        resourceId,
        command
      );
      assertEvidenceScope(resource, record);

      const claim = await claimIdempotency<T>(
        transaction.idempotency,
        command.idempotencyKey,
        fingerprint
      );
      if (claim.state === "COMPLETED" && claim.record.result) {
        return claim.record.result;
      }
      if (claim.state === "IN_PROGRESS" || claim.state === "FAILED") {
        throw new ControlPlaneError(
          "CONFLICT",
          "Resource evidence command is already in progress or previously failed"
        );
      }

      await selectStore(transaction.stores).append(Object.freeze({ ...record }) as T);
      await transaction.audit.append(createAuditEvent({
        correlationId: command.correlationId,
        eventType,
        actor: command.actor,
        scope: {
          userId: command.scope.userId,
          portfolioId: command.scope.portfolioId,
          companyId: command.scope.companyId,
          resourceId
        },
        environment: command.environment,
        entityType: "resource",
        entityId: resourceId,
        provenance: command.provenance,
        metadata: {
          commandId: command.commandId,
          evidenceId: record.id
        }
      }));
      await transaction.idempotency.complete(
        command.idempotencyKey,
        fingerprint,
        record,
        record.observedAt
      );
      return record;
    });
  }

  addIdentityEvidence(
    resourceId: string,
    record: ResourceIdentityEvidence,
    command: AuthoritativeCommandEnvelope
  ) {
    return this.appendEvidence(
      resourceId,
      record,
      command,
      "resource.identity-evidence-recorded",
      (stores) => stores.identities
    );
  }

  addTrustEvidence(
    resourceId: string,
    record: ResourceTrustEvidence,
    command: AuthoritativeCommandEnvelope
  ) {
    return this.appendEvidence(
      resourceId,
      record,
      command,
      "resource.trust-evidence-recorded",
      (stores) => stores.trust
    );
  }

  addHealthRecord(
    resourceId: string,
    record: ResourceHealthRecord,
    command: AuthoritativeCommandEnvelope
  ) {
    return this.appendEvidence(
      resourceId,
      record,
      command,
      "resource.health-recorded",
      (stores) => stores.health
    );
  }

  addCapabilityBinding(
    resourceId: string,
    record: ResourceCapabilityBinding,
    command: AuthoritativeCommandEnvelope
  ) {
    return this.appendEvidence(
      resourceId,
      record,
      command,
      "resource.capability-validated",
      (stores) => stores.capabilities
    );
  }

  addLocation(
    resourceId: string,
    record: ResourceLocation,
    command: AuthoritativeCommandEnvelope
  ) {
    return this.appendEvidence(
      resourceId,
      record,
      command,
      "resource.location-recorded",
      (stores) => stores.locations
    );
  }

  addCostProfile(
    resourceId: string,
    record: ResourceCostProfile,
    command: AuthoritativeCommandEnvelope
  ) {
    return this.appendEvidence(
      resourceId,
      record,
      command,
      "resource.cost-profile-recorded",
      (stores) => stores.costs
    );
  }

  addProviderBinding(
    resourceId: string,
    record: ResourceProviderBinding,
    command: AuthoritativeCommandEnvelope
  ) {
    return this.appendEvidence(
      resourceId,
      record,
      command,
      "resource.provider-binding-recorded",
      (stores) => stores.providers
    );
  }

  beginEnrollment(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.resources,
      entityType: "resource",
      entityId: id,
      to: "enrolling",
      command,
      triggeringEvent: "resource-enrollment-started"
    });
  }

  beginProfiling(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.resources,
      entityType: "resource",
      entityId: id,
      to: "profiling",
      command,
      triggeringEvent: "resource-profiling-started"
    });
  }

  beginValidation(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.resources,
      entityType: "resource",
      entityId: id,
      to: "validating",
      command,
      triggeringEvent: "resource-validation-started"
    });
  }

  markReady(
    id: string,
    command: AuthoritativeCommandEnvelope,
    evaluatedAt = new Date().toISOString()
  ) {
    let snapshot: ResourceRegistryEvidenceSnapshot | undefined;

    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.resources,
      entityType: "resource",
      entityId: id,
      to: "ready",
      command,
      triggeringEvent: "resource-ready",
      beforeTransition: async (current, transaction) => {
        snapshot = await evidenceSnapshot(transaction.stores, id);
        const readiness = evaluateResourceReadiness(
          current,
          snapshot,
          Date.parse(evaluatedAt)
        );
        if (!readiness.ready) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Resource cannot become READY: " + readiness.reasons.join(", ")
          );
        }
      },
      patch: () => {
        if (!snapshot) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            "Resource readiness evidence snapshot is unavailable"
          );
        }
        return {
          identityEvidenceIds: snapshot.identities.map((item) => item.id),
          trustEvidenceIds: snapshot.trust.map((item) => item.id),
          healthRecordIds: snapshot.health.map((item) => item.id),
          capabilityBindingIds: snapshot.capabilities.map((item) => item.id),
          locationIds: snapshot.locations.map((item) => item.id),
          costProfileIds: snapshot.costs.map((item) => item.id),
          providerBindingIds: snapshot.providers.map((item) => item.id)
        };
      }
    });
  }

  markDegraded(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.resources,
      entityType: "resource",
      entityId: id,
      to: "degraded",
      command,
      triggeringEvent: "resource-degraded"
    });
  }

  markUnreachable(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.resources,
      entityType: "resource",
      entityId: id,
      to: "unreachable",
      command,
      triggeringEvent: "resource-unreachable"
    });
  }

  disable(id: string, command: AuthoritativeCommandEnvelope) {
    return executeTransitionCommand({
      manager: this.transactions,
      selectStore: (stores) => stores.resources,
      entityType: "resource",
      entityId: id,
      to: "disabled",
      command,
      triggeringEvent: "resource-disabled"
    });
  }

  async readModel(
    id: string,
    command: AuthoritativeCommandEnvelope,
    now = Date.now()
  ): Promise<ResourceRegistryReadModel> {
    return this.transactions.run(async (transaction) => {
      const resource = await requireEntity(
        transaction.stores.resources,
        id,
        command
      );
      const snapshot = await evidenceSnapshot(transaction.stores, id);
      return buildResourceRegistryReadModel(resource, snapshot, now);
    });
  }
}
