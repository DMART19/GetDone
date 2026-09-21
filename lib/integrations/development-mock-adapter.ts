import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type {
  CompanyIntegration,
  IntegrationAdapter,
  IntegrationAuthenticationEvidence
} from "@/lib/integrations/contracts";

export class DevelopmentMockIntegrationAdapter implements IntegrationAdapter {
  readonly id: string;
  readonly version = "1.0.0";
  readonly mock = true;
  private readonly now: () => Date;

  constructor(
    id = "development-mock-integration",
    now: () => Date = () => new Date()
  ) {
    this.id = id;
    this.now = now;
  }

  async authenticate(input: {
    integration: CompanyIntegration;
    credentialBindingId?: string;
  }): Promise<IntegrationAuthenticationEvidence> {
    if (input.integration.environment !== "development") {
      throw new Error("Development mock integration adapter is DEVELOPMENT-only");
    }
    if (
      input.integration.adapterId !== this.id
      || input.integration.adapterVersion !== this.version
    ) {
      throw new Error("Development mock integration adapter identity does not match registry binding");
    }
    if (input.credentialBindingId !== input.integration.credentialBindingId) {
      throw new Error("Development mock integration credential reference does not match registry binding");
    }
    const base = {
      source: "integration-adapter" as const,
      integrationId: input.integration.id,
      companyId: input.integration.companyId,
      environment: input.integration.environment,
      adapterId: this.id,
      adapterVersion: this.version,
      authenticated: true,
      credentialBindingId: input.credentialBindingId,
      observedAt: this.now().toISOString()
    };
    return Object.freeze({ ...base, evidenceHash: sha256Hex(base) });
  }
}
