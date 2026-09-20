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

  constructor(id = "development-mock-integration") {
    this.id = id;
  }

  async authenticate(input: {
    integration: CompanyIntegration;
    credentialBindingId?: string;
  }): Promise<IntegrationAuthenticationEvidence> {
    if (input.integration.environment !== "development") {
      throw new Error("Development mock integration adapter is DEVELOPMENT-only");
    }
    const base = {
      source: "integration-adapter" as const,
      integrationId: input.integration.id,
      companyId: input.integration.companyId,
      environment: input.integration.environment,
      adapterId: input.integration.adapterId,
      adapterVersion: input.integration.adapterVersion,
      authenticated: true,
      credentialBindingId: input.credentialBindingId,
      observedAt: new Date().toISOString()
    };
    return Object.freeze({ ...base, evidenceHash: sha256Hex(base) });
  }
}
