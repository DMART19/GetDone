import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import {
  applyIntegrationVerification,
  assertManagedIntegrationScope,
  controlManagedIntegration,
  createManagedIntegration,
  type IntegrationConfigurationCreateInput,
  type IntegrationConfigurationStore,
  type IntegrationConfigurationUpdateInput,
  type IntegrationVerificationEvidence,
  listIntegrationProviders,
  updateManagedIntegration
} from "@/lib/integrations/management";

export class IntegrationConfigurationService {
  constructor(
    private readonly store: IntegrationConfigurationStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  providers() {
    return listIntegrationProviders();
  }

  async list(scope: TrustedExecutionScope) {
    const records = await this.store.listByScope(
      scope.portfolioId,
      scope.companyId,
      scope.environment
    );
    return Object.freeze(
      records.map((record) => assertManagedIntegrationScope(record, scope))
    );
  }

  async get(scope: TrustedExecutionScope, id: string) {
    const record = await this.store.get(id);
    if (!record) return null;
    return assertManagedIntegrationScope(record, scope);
  }

  async create(input: {
    scope: TrustedExecutionScope;
    config: IntegrationConfigurationCreateInput;
    idempotencyKey: string;
  }) {
    const requestHash = sha256Hex({
      action: "create",
      scope: {
        portfolioId: input.scope.portfolioId,
        companyId: input.scope.companyId,
        environment: input.scope.environment
      },
      config: input.config
    });
    const record = createManagedIntegration({
      id: input.config.id,
      scope: input.scope,
      config: input.config,
      createdAt: this.now().toISOString()
    });
    return this.store.create(record, {
      idempotencyKey: input.idempotencyKey,
      requestHash
    });
  }

  async update(input: {
    scope: TrustedExecutionScope;
    id: string;
    patch: IntegrationConfigurationUpdateInput;
    idempotencyKey: string;
  }) {
    const current = await this.get(input.scope, input.id);
    if (!current) {
      throw new ControlPlaneError("NOT_FOUND", "Integration configuration was not found");
    }
    const requestHash = sha256Hex({
      action: "update",
      integrationId: input.id,
      expectedRecordHash: current.recordHash,
      patch: input.patch
    });
    const record = updateManagedIntegration({
      record: current,
      scope: input.scope,
      patch: input.patch,
      updatedAt: this.now().toISOString()
    });
    return this.store.save(record, {
      idempotencyKey: input.idempotencyKey,
      requestHash,
      expectedRecordHash: current.recordHash
    });
  }

  async control(input: {
    scope: TrustedExecutionScope;
    id: string;
    action: "disable" | "revoke";
    idempotencyKey: string;
  }) {
    const current = await this.get(input.scope, input.id);
    if (!current) {
      throw new ControlPlaneError("NOT_FOUND", "Integration configuration was not found");
    }
    if (
      (input.action === "disable" && current.state === "disabled")
      || (input.action === "revoke" && current.state === "revoked")
    ) {
      return current;
    }
    const requestHash = sha256Hex({
      action: input.action,
      integrationId: input.id,
      expectedRecordHash: current.recordHash
    });
    const record = controlManagedIntegration({
      record: current,
      scope: input.scope,
      action: input.action,
      at: this.now().toISOString()
    });
    return this.store.save(record, {
      idempotencyKey: input.idempotencyKey,
      requestHash,
      expectedRecordHash: current.recordHash
    });
  }

  async recordVerification(input: {
    scope: TrustedExecutionScope;
    evidence: IntegrationVerificationEvidence;
  }) {
    const current = await this.get(input.scope, input.evidence.integrationId);
    if (!current) {
      throw new ControlPlaneError("NOT_FOUND", "Integration configuration was not found");
    }
    const record = applyIntegrationVerification({
      record: current,
      scope: input.scope,
      evidence: input.evidence
    });
    await this.store.appendVerification(input.evidence);
    return this.store.save(record, {
      idempotencyKey: `verification:${input.evidence.evidenceHash}`,
      requestHash: input.evidence.evidenceHash,
      expectedRecordHash: current.recordHash
    });
  }
}
