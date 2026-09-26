import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export const INTEGRATION_REGISTRY_CONTRACT_VERSION = "1.0.0";

export type IntegrationKind =
  | "stripe"
  | "github"
  | "sentry"
  | "analytics"
  | "hubspot"
  | "calendar"
  | "gmail"
  | "slack"
  | "notion"
  | "rest-api"
  | "webhook"
  | "mcp";

export type IntegrationConnectionState =
  | "disconnected"
  | "authenticating"
  | "connected"
  | "degraded"
  | "disabled"
  | "revoked";

export interface CompanyIntegration {
  id: string;
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  kind: IntegrationKind;
  displayName: string;
  adapterId: string;
  adapterVersion: string;
  credentialBindingId?: string;
  readScopes: readonly string[];
  writeScopes: readonly string[];
  state: IntegrationConnectionState;
  mock: boolean;
  createdAt: string;
  updatedAt: string;
  recordHash: string;
}

export interface IntegrationAuthenticationEvidence {
  source: "integration-adapter";
  integrationId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  adapterId: string;
  adapterVersion: string;
  authenticated: boolean;
  credentialBindingId?: string;
  observedAt: string;
  evidenceHash: string;
}

export interface IntegrationAdapter {
  readonly id: string;
  readonly version: string;
  readonly mock: boolean;
  authenticate(input: {
    integration: CompanyIntegration;
    credentialBindingId?: string;
  }): Promise<IntegrationAuthenticationEvidence>;
}

export interface IntegrationRegistryStore {
  get(id: string): Promise<CompanyIntegration | null>;
  put(record: CompanyIntegration): Promise<void>;
  listByCompany(input: {
    portfolioId: string;
    companyId: string;
    environment?: TrustedExecutionScope["environment"];
  }): Promise<readonly CompanyIntegration[]>;
}
