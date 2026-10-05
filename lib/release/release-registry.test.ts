import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_POLICY_VERSION } from "@/lib/domain/policy-registry";
import { POLICY_ENGINE_VERSION } from "@/lib/planning/policy-engine";
import {
  AI_GATEWAY_CONTRACT_VERSION,
  AI_ROUTING_POLICY_CONTRACT_VERSION
} from "@/lib/ai-gateway/contracts";
import { INTEGRATION_REGISTRY_CONTRACT_VERSION } from "@/lib/integrations/contracts";
import { JOB_RUNTIME_CONTRACT_VERSION } from "@/lib/execution/job-runtime-contracts";
import { BUSINESS_ACTION_ADAPTER_CONTRACT_VERSION } from "@/lib/execution/adapters/business-action";
import { SOFTWARE_WORKER_CONTRACT_VERSION } from "@/lib/execution/software-worker";
import { JOB_EXECUTION_BRIDGE_CONTRACT_VERSION } from "@/lib/domain/services/job-execution-bridge";
import { STORAGE_FABRIC_CONTRACT_VERSION } from "@/lib/resources/storage-fabric";
import { RESILIENCE_CONTRACT_VERSION } from "@/lib/resources/resilience";
import { RESOURCE_ADAPTER_SDK_CONTRACT_VERSION } from "@/lib/resources/adapter-sdk";
import { RESOURCE_POOL_CONTRACT_VERSION } from "@/lib/resources/pools";
import { PHASE44_DETERMINISTIC_HARNESS_VERSION } from "@/lib/security/phase44-adversarial-harness";
import { CONTROL_API_SURFACE_VERSION } from "@/lib/control-api/contracts";
import { OPENROUTER_ADAPTER_VERSION } from "@/lib/ai-gateway/openrouter-adapter";
import { CONFIGURED_HTTP_ACTION_ADAPTER_VERSION } from "@/lib/execution/adapters/configured-http-action";
import { CONFIGURED_WEBHOOK_ACTION_ADAPTER_VERSION } from "@/lib/execution/adapters/configured-webhook-action";
import { GMAIL_BUSINESS_ACTION_ADAPTER_VERSION } from "@/lib/execution/adapters/gmail-action";
import { SLACK_BUSINESS_ACTION_ADAPTER_VERSION } from "@/lib/execution/adapters/slack-action";
import { CRM_BUSINESS_ACTION_ADAPTER_VERSION } from "@/lib/execution/adapters/crm-action";
import { GITHUB_STANDARD_OPERATION_ADAPTER_VERSION } from "@/lib/execution/adapters/github-standard-operation";
import { ANALYTICS_DATA_INGESTION_ADAPTER_VERSION } from "@/lib/execution/adapters/analytics-ingestion";
import {
  NODE_AGENT_PROTOCOL_VERSION,
  NODE_DOMAIN_VERSION
} from "@/lib/nodes/contracts";
import { NODE_DISPATCH_CONTRACT_VERSION } from "@/lib/nodes/dispatch-contracts";
import { NODE_IDENTITY_CONTRACT_VERSION } from "@/lib/nodes/identity";

interface VersionedSource {
  version: string;
  sourcePath: string;
  contractTracked?: boolean;
  contractSourcePaths?: string[];
}
interface AdapterVersion extends VersionedSource {
  status: string;
}
interface ReleaseRegistryShape {
  registrySchemaVersion: string;
  environmentManifestSchemaVersion: string;
  appVersion: string;
  policy: { registryVersion: string; engineVersion: string };
  database: {
    status: string;
    engine: string;
    minimumEngineVersion: string;
    migrationVersion: string;
    schemaVersion: string;
  };
  aiGateway: {
    contractVersion: string;
    routingPolicyContractVersion: string;
    status: string;
    adapterVersion: string;
    routingPolicyVersion: string;
  };
  controlApi: {
    surfaceVersion: string;
    status: string;
    applicationAdapterStatus: string;
    authStatus: string;
    persistenceStatus: string;
    sourcePath: string;
  };
  nodeAgent: {
    status: string;
    domainVersion: string;
    protocolVersion: string;
    dispatchContractVersion: string;
    linuxX64: string;
    linuxArm64: string;
    productionReady: boolean;
    agentVersion: string;
    enrollmentStatus: string;
    nodePersistenceStatus: string;
    identityIssuerStatus: string;
    productionCaStatus: string;
    productionMtlsStatus: string;
    enrollmentMigrationVersion: string;
    bootstrapAuthentication: string;
    inventoryDiscoveryStatus: string;
    inventoryApiStatus: string;
    inventoryPersistenceStatus: string;
    authenticatedAgentTransportStatus: string;
    inventoryMigrationVersion: string;
    capabilityProfilingStatus: string;
    capabilityValidationStatus: string;
    capabilityApiStatus: string;
    capabilityPersistenceStatus: string;
    capabilityRegistryBridgeStatus: string;
    resourceCapabilityBindingStatus: string;
    capabilityMigrationVersion: string;
    sourcePaths: string[];
  };
  integrations: {
    registryContractVersion: string;
    liveAdaptersStatus: string;
    adapterImplementationStatus: string;
  };
  execution: {
    jobRuntimeContractVersion: string;
    durableJobStoreStatus: string;
    durableJobStoreVersion: string;
    businessActionContractVersion: string;
    businessActionOrchestratorStatus: string;
    businessActionOrchestratorVersion: string;
    businessAdaptersStatus: string;
    softwareWorkerContractVersion: string;
    softwareWorkerRuntimeStatus: string;
    softwareWorkerRuntimeVersion: string;
    softwareDeploymentStatus: string;
    jobExecutionRouterStatus: string;
    jobExecutionRouterVersion: string;
    persistentWorkerServiceStatus: string;
    persistentWorkerServiceVersion: string;
    jobExecutionBridgeContractVersion: string;
    jobExecutionBridgeStatus: string;
    liveJobExecutionBridgeStoreStatus: string;
    jobExecutionBridgeStoreImplementationStatus: string;
    persistenceBackend: string;
  };
  composition: {
    goldenPathHarnessVersion: string;
    status: string;
    productionExecutionClaimed: boolean;
    sourcePath: string;
  };
  resourceFabric: {
    storageFabricContractVersion: string;
    storageRuntimeStatus: string;
    resilienceContractVersion: string;
    failoverRuntimeStatus: string;
    resourceAdapterSdkContractVersion: string;
    secondProviderStatus: string;
    resourcePoolContractVersion: string;
    partnerPoolRuntimeStatus: string;
  };
  phase44: {
    deterministicHarnessVersion: string;
    deterministicHarnessStatus: string;
    productionAcceptanceStatus: string;
    sourcePath: string;
  };
  voice: {
    contractVersion: string;
    adapterContractVersion: string;
    adapterStatus: string;
    adapterVersion: string;
    speechProvider: string;
    requiredForProduction: boolean;
    strongApprovalHandling: string;
    credentialHandling: string;
    sourcePath: string;
  };
  schemaVersions: Record<string, VersionedSource>;
  adapters: Record<string, AdapterVersion>;
  acceptanceEvidencePaths: string[];
  manualSourcePaths: string[];
  generatedArtifacts: { machineManifest: string; operatingManual: string };
}
interface EnvironmentShape {
  productionReady: boolean;
  connections: Record<string, boolean>;
  deployment: { status: string; deploymentId: string | null };
  database: {
    engine: string;
    minimumEngineVersion: string;
    adapterStatus: string;
    migrationVersion: string;
    schemaVersion: string;
  };
  aiGateway: {
    contractStatus: string;
    adapterStatus: string;
    adapterImplementationStatus: string;
    routingPolicyStatus: string;
    provider: string;
  };
  controlApi: {
    surfaceStatus: string;
    applicationAdapterStatus: string;
    authStatus: string;
    persistenceStatus: string;
  };
  nodeAgent: {
    status: string;
    domainVersion: string;
    protocolVersion: string;
    dispatchContractVersion: string;
    linuxX64: string;
    linuxArm64: string;
    productionReady: boolean;
    agentVersion: string;
    enrollmentStatus: string;
    nodePersistenceStatus: string;
    identityIssuerStatus: string;
    productionCaStatus: string;
    productionMtlsStatus: string;
    enrollmentMigrationVersion: string;
    bootstrapAuthentication: string;
    inventoryDiscoveryStatus: string;
    inventoryApiStatus: string;
    inventoryPersistenceStatus: string;
    authenticatedAgentTransportStatus: string;
    inventoryMigrationVersion: string;
    capabilityProfilingStatus: string;
    capabilityValidationStatus: string;
    capabilityApiStatus: string;
    capabilityPersistenceStatus: string;
    capabilityRegistryBridgeStatus: string;
    resourceCapabilityBindingStatus: string;
    capabilityMigrationVersion: string;
  };
  integrations: {
    registryStatus: string;
    adapterStatus: string;
    mockAllowed: boolean;
  };
  execution: {
    jobRuntimeContractStatus: string;
    durableJobStoreStatus: string;
    durableJobStoreImplementationStatus: string;
    businessActionOrchestratorStatus: string;
    businessActionAdapterStatus: string;
    softwareWorkerRuntimeStatus: string;
    softwareDeploymentStatus: string;
    jobExecutionRouterStatus: string;
    jobExecutionBridgeStatus: string;
    jobExecutionBridgeStoreImplementationStatus: string;
    liveJobExecutionBridgeStoreStatus: string;
  };
  composition: {
    goldenPathHarnessStatus: string;
    productionExecutionClaimed: boolean;
  };
  resourceFabric: {
    storageFabricContractStatus: string;
    storageRuntimeStatus: string;
    resilienceContractStatus: string;
    failoverRuntimeStatus: string;
    resourceAdapterSdkStatus: string;
    secondProviderStatus: string;
    resourcePoolContractStatus: string;
    partnerPoolRuntimeStatus: string;
    developmentMockAdapterAllowed: boolean;
  };
  phase44: {
    deterministicHarnessStatus: string;
    productionAcceptanceStatus: string;
  };
  voice: {
    contractStatus: string;
    adapterStatus: string;
    strongApprovalAllowed: boolean;
    rawCredentialInputAllowed: boolean;
    secureHandoff: string;
  };
}
interface EnvironmentManifestShape {
  manifestSchemaVersion: string;
  environments: Record<"development" | "staging" | "production", EnvironmentShape>;
}

const root = process.cwd();
function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")) as T;
}

const registry = readJson<ReleaseRegistryShape>("release/version-registry.json");
const environment = readJson<EnvironmentManifestShape>("release/environment-manifest.json");
const packageJson = readJson<{ version: string }>("package.json");

describe("Phase 41 release/version registry", () => {
  it("binds application policy and machine-readable schema versions", () => {
    expect(registry.registrySchemaVersion).toBe("1.6.0");
    expect(registry.environmentManifestSchemaVersion).toBe("1.7.0");
    expect(environment.manifestSchemaVersion).toBe("1.7.0");
    expect(registry.schemaVersions.releaseManifest.version).toBe("1.6.0");
    expect(registry.appVersion).toBe(packageJson.version);
    expect(registry.policy.registryVersion).toBe(CURRENT_POLICY_VERSION);
    expect(registry.policy.engineVersion).toBe(POLICY_ENGINE_VERSION);
  });

  it("binds every declared schema and adapter to existing source files", () => {
    for (const entry of Object.values(registry.schemaVersions)) {
      expect(entry.version.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(root, entry.sourcePath))).toBe(true);
      for (const source of entry.contractSourcePaths ?? []) {
        expect(fs.existsSync(path.join(root, source))).toBe(true);
      }
    }
    for (const entry of Object.values(registry.adapters)) {
      expect(entry.version.length).toBeGreaterThan(0);
      expect(entry.status.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(root, entry.sourcePath))).toBe(true);
    }
  });

  it("records the implemented OpenRouter adapter without inventing a live AI connection", () => {
    expect(registry.aiGateway).toMatchObject({
      contractVersion: AI_GATEWAY_CONTRACT_VERSION,
      routingPolicyContractVersion: AI_ROUTING_POLICY_CONTRACT_VERSION,
      status: "runtime-wired-unconnected",
      adapterVersion: OPENROUTER_ADAPTER_VERSION,
      routingPolicyVersion: "UNCONFIGURED"
    });
    expect(registry.adapters.aiGateway.status).toBe("contract-only");
    expect(registry.adapters.openRouter).toMatchObject({
      status: "implemented-unconfigured",
      version: OPENROUTER_ADAPTER_VERSION
    });
    expect(registry.adapters.configuredHttpAction).toMatchObject({
      status: "implemented-unconfigured",
      version: CONFIGURED_HTTP_ACTION_ADAPTER_VERSION
    });
  });

  it("records Phase 28.4 capability profiling without claiming live capability binding connectivity", () => {
    expect(registry.nodeAgent).toMatchObject({
      status: "implemented-development-only",
      domainVersion: NODE_DOMAIN_VERSION,
      protocolVersion: NODE_AGENT_PROTOCOL_VERSION,
      dispatchContractVersion: NODE_DISPATCH_CONTRACT_VERSION,
      linuxX64: "capability-profile-build",
      linuxArm64: "capability-profile-build",
      productionReady: false,
      agentVersion: "0.4.0-development",
      enrollmentStatus: "implemented-unconnected",
      nodePersistenceStatus: "implemented-unconnected",
      identityIssuerStatus: "development-only",
      productionCaStatus: "not-connected",
      productionMtlsStatus: "not-connected",
      enrollmentMigrationVersion: "2026-09-21.2",
      bootstrapAuthentication: "one-time-token",
      inventoryDiscoveryStatus: "implemented",
      inventoryApiStatus: "implemented-unconnected",
      inventoryPersistenceStatus: "implemented-unconnected",
      authenticatedAgentTransportStatus: "not-connected",
      inventoryMigrationVersion: "2026-09-21.3",
      capabilityProfilingStatus: "implemented",
      capabilityValidationStatus: "implemented",
      capabilityApiStatus: "implemented-unconnected",
      capabilityPersistenceStatus: "implemented-unconnected",
      capabilityRegistryBridgeStatus: "implemented",
      resourceCapabilityBindingStatus: "implemented-unconnected",
      capabilityMigrationVersion: "2026-09-21.4"
    });
    expect(registry.schemaVersions.nodeDomain).toMatchObject({
      version: NODE_DOMAIN_VERSION,
      contractTracked: true
    });
    expect(registry.schemaVersions.nodeDispatch).toMatchObject({
      version: NODE_DISPATCH_CONTRACT_VERSION,
      contractTracked: true
    });
    expect(registry.schemaVersions.nodeIdentity).toMatchObject({
      version: NODE_IDENTITY_CONTRACT_VERSION,
      contractTracked: true
    });
    expect(registry.schemaVersions.nodeInventory).toMatchObject({
      version: "1.0.0"
    });
    expect(registry.schemaVersions.nodeCapability).toMatchObject({
      version: "1.0.0"
    });
    expect(registry.schemaVersions.nodeCapabilityBridge).toMatchObject({
      version: "1.0.0"
    });
    for (const state of Object.values(environment.environments)) {
      expect(state.connections.resourceAgent).toBe(false);
      expect(state.nodeAgent).toMatchObject({
        status: "implemented-development-only",
        domainVersion: NODE_DOMAIN_VERSION,
        protocolVersion: NODE_AGENT_PROTOCOL_VERSION,
        dispatchContractVersion: NODE_DISPATCH_CONTRACT_VERSION,
        linuxX64: "capability-profile-build",
        linuxArm64: "capability-profile-build",
        productionReady: false,
        agentVersion: "0.4.0-development",
        inventoryDiscoveryStatus: "implemented",
        inventoryApiStatus: "implemented-unconnected",
        inventoryPersistenceStatus: "implemented-unconnected",
        authenticatedAgentTransportStatus: "not-connected",
        inventoryMigrationVersion: "2026-09-21.3",
        capabilityProfilingStatus: "implemented",
        capabilityValidationStatus: "implemented",
        capabilityApiStatus: "implemented-unconnected",
        capabilityPersistenceStatus: "implemented-unconnected",
        capabilityRegistryBridgeStatus: "implemented",
        resourceCapabilityBindingStatus: "implemented-unconnected",
        capabilityMigrationVersion: "2026-09-21.4"
      });
    }
  });

  it("records the Control API surface without claiming auth or persistence connectivity", () => {
    expect(registry.controlApi).toMatchObject({
      surfaceVersion: CONTROL_API_SURFACE_VERSION,
      status: "implemented-unconnected",
      applicationAdapterStatus: "not-connected",
      authStatus: "implemented-unconnected",
      persistenceStatus: "not-connected"
    });
    for (const state of Object.values(environment.environments)) {
      expect(state.controlApi).toMatchObject({
        surfaceStatus: "implemented",
        applicationAdapterStatus: "not-connected",
        authStatus: "implemented-unconnected",
        persistenceStatus: "not-connected"
      });
      expect(state.aiGateway).toMatchObject({
        adapterStatus: "not-connected",
        adapterImplementationStatus: "implemented-unconfigured",
        provider: "OPENROUTER_UNCONFIGURED"
      });
    }
  });

  it("records Phase 4 contracts plus implemented-but-unconnected production execution runtimes", () => {
    expect(registry.integrations).toMatchObject({
      registryContractVersion: INTEGRATION_REGISTRY_CONTRACT_VERSION,
      liveAdaptersStatus: "not-connected",
      adapterImplementationStatus: "implemented-unconfigured"
    });
    expect(registry.adapters.configuredHttpAction).toMatchObject({
      status: "implemented-unconfigured",
      version: CONFIGURED_HTTP_ACTION_ADAPTER_VERSION
    });
    expect(registry.adapters.configuredWebhookAction).toMatchObject({
      status: "implemented-unconfigured",
      version: CONFIGURED_WEBHOOK_ACTION_ADAPTER_VERSION
    });
    expect(registry.adapters.gmailBusinessAction).toMatchObject({
      status: "implemented-unconfigured",
      version: GMAIL_BUSINESS_ACTION_ADAPTER_VERSION
    });
    expect(registry.adapters.slackBusinessAction).toMatchObject({
      status: "implemented-unconfigured",
      version: SLACK_BUSINESS_ACTION_ADAPTER_VERSION
    });
    expect(registry.adapters.crmBusinessAction).toMatchObject({
      status: "implemented-unconfigured",
      version: CRM_BUSINESS_ACTION_ADAPTER_VERSION
    });
    expect(registry.adapters.githubStandardOperation).toMatchObject({
      status: "implemented-unconfigured",
      version: GITHUB_STANDARD_OPERATION_ADAPTER_VERSION
    });
    expect(registry.adapters.analyticsDataIngestion).toMatchObject({
      status: "implemented-unconfigured",
      version: ANALYTICS_DATA_INGESTION_ADAPTER_VERSION
    });
    expect(registry.schemaVersions.analyticsIngestion).toMatchObject({
      version: "1.0.0",
      sourcePath: "lib/analytics/ingestion.ts",
      contractTracked: true
    });
    expect(registry.schemaVersions.environmentEvidence).toMatchObject({
      version: "1.0.0",
      sourcePath: "config/environment-evidence-policy.json",
      contractTracked: true
    });
    expect(registry.execution).toMatchObject({
      jobRuntimeContractVersion: JOB_RUNTIME_CONTRACT_VERSION,
      durableJobStoreStatus: "implemented-unconnected",
      durableJobStoreVersion: "1.0.0",
      businessActionContractVersion: BUSINESS_ACTION_ADAPTER_CONTRACT_VERSION,
      businessActionOrchestratorStatus: "implemented",
      businessActionOrchestratorVersion: "1.0.0",
      businessAdaptersStatus: "implemented-unconfigured",
      softwareWorkerContractVersion: SOFTWARE_WORKER_CONTRACT_VERSION,
      softwareWorkerRuntimeStatus: "implemented",
      softwareWorkerRuntimeVersion: "1.0.0",
      softwareDeploymentStatus: "not-connected",
      jobExecutionRouterStatus: "implemented",
      jobExecutionRouterVersion: "1.2.0",
      jobExecutionBridgeContractVersion: JOB_EXECUTION_BRIDGE_CONTRACT_VERSION,
      jobExecutionBridgeStatus: "deterministic-contract",
      liveJobExecutionBridgeStoreStatus: "not-connected",
      jobExecutionBridgeStoreImplementationStatus: "implemented-unconnected",
      persistenceBackend: "postgresql"
    });
    expect(registry.composition).toMatchObject({
      goldenPathHarnessVersion: "1.1.0",
      status: "deterministic-simulation-only",
      productionExecutionClaimed: false,
      sourcePath: "lib/composition/golden-path-harness.ts",
      mvpBusinessWorkflowVersion: "1.0.0",
      mvpBusinessWorkflowStatus: "implemented-unconfigured"
    });
  });

  it("binds deterministic Phases 36-39 without inventing live infrastructure", () => {
    expect(registry.resourceFabric).toMatchObject({
      storageFabricContractVersion: STORAGE_FABRIC_CONTRACT_VERSION,
      storageRuntimeStatus: "not-connected",
      resilienceContractVersion: RESILIENCE_CONTRACT_VERSION,
      failoverRuntimeStatus: "not-connected",
      resourceAdapterSdkContractVersion: RESOURCE_ADAPTER_SDK_CONTRACT_VERSION,
      secondProviderStatus: "not-connected",
      resourcePoolContractVersion: RESOURCE_POOL_CONTRACT_VERSION,
      partnerPoolRuntimeStatus: "not-connected"
    });
    expect(registry.adapters.resourceAdapterSdk).toMatchObject({
      status: "contract-only",
      version: RESOURCE_ADAPTER_SDK_CONTRACT_VERSION
    });
  });

  it("binds Phase 44 offline harness without claiming production acceptance", () => {
    expect(registry.phase44).toMatchObject({
      deterministicHarnessVersion: PHASE44_DETERMINISTIC_HARNESS_VERSION,
      deterministicHarnessStatus: "contract-and-offline-tests",
      productionAcceptanceStatus: "not-run",
      sourcePath: "lib/security/phase44-adversarial-harness.ts"
    });
  });

  it("records PostgreSQL persistence implementation without claiming a live database", () => {
    expect(registry.controlApi).toMatchObject({
      status: "implemented-unconnected",
      authStatus: "implemented-unconnected",
      persistenceStatus: "not-connected"
    });
    for (const state of Object.values(environment.environments)) {
      expect(state.connections.auth).toBe(false);
      expect(state.controlApi.authStatus).toBe("implemented-unconnected");
    }

    expect(registry.database).toMatchObject({
      status: "implemented-unconnected",
      engine: "postgresql",
      minimumEngineVersion: "16",
      migrationVersion: "2026-09-28.9zz",
      schemaVersion: "2.2.0"
    });
    expect(registry.adapters.postgresPersistence).toMatchObject({
      status: "implemented-unconnected",
      version: "1.1.0"
    });
    expect(registry.schemaVersions.postgresPersistence).toMatchObject({
      version: "1.1.0",
      sourcePath: "lib/persistence/postgres/client.ts"
    });
    expect(registry.schemaVersions.disasterRecovery).toMatchObject({
      version: "1.0.0",
      sourcePath: "lib/execution/disaster-recovery.ts",
      contractTracked: true
    });
    expect(registry.schemaVersions.zeroDowntimeMigrationPolicy).toMatchObject({
      version: "1.1.0",
      sourcePath: "config/zero-downtime-migration-policy.json",
      contractTracked: true
    });
    expect(registry.schemaVersions.productionReleaseGate).toMatchObject({
      version: "1.0.0",
      sourcePath: "scripts/verify-production-promotion.mjs",
      contractTracked: true
    });
    for (const state of Object.values(environment.environments)) {
      expect(state.connections.database).toBe(false);
      expect(state.database).toMatchObject({
        engine: "postgresql",
        minimumEngineVersion: "16",
        adapterStatus: "implemented-unconnected",
        migrationVersion: "2026-09-25.3",
        schemaVersion: "2.2.0"
      });
      expect(state.execution).toMatchObject({
        durableJobStoreStatus: "not-connected",
        durableJobStoreImplementationStatus: "implemented-unconnected",
        businessActionOrchestratorStatus: "implemented",
        businessActionAdapterStatus: "not-connected",
        softwareWorkerRuntimeStatus: "implemented",
        softwareDeploymentStatus: "not-connected",
        jobExecutionRouterStatus: "implemented",
        jobExecutionBridgeStoreImplementationStatus: "implemented-unconnected",
        liveJobExecutionBridgeStoreStatus: "not-connected"
      });
    }
  });

  it("preserves Phase 42 voice authority and live-adapter absence", () => {
    expect(registry.adapters.voiceIntent).toMatchObject({
      status: "contract-only",
      version: "1.0.0",
      sourcePath: "lib/voice/voice-intents.ts"
    });
    expect(registry.voice).toMatchObject({
      contractVersion: "1.0.0",
      adapterContractVersion: "1.0.0",
      adapterStatus: "not-connected",
      adapterVersion: "UNIMPLEMENTED",
      speechProvider: "UNCONFIGURED",
      requiredForProduction: true,
      strongApprovalHandling: "secure-phone-only",
      credentialHandling: "secure-provider-or-phone-only"
    });
  });

  it("defines development staging and production without overstating runtime readiness", () => {
    expect(Object.keys(environment.environments).sort())
      .toEqual(["development", "production", "staging"]);
    expect(environment.environments.production.productionReady).toBe(false);
    for (const [name, state] of Object.entries(environment.environments)) {
      expect(state.connections.storageFabricRuntime).toBe(false);
      expect(state.connections.resilienceFailoverRuntime).toBe(false);
      expect(state.connections.secondResourceProvider).toBe(false);
      expect(state.connections.partnerPoolRuntime).toBe(false);
      expect(state.resourceFabric).toMatchObject({
        storageFabricContractStatus: "deterministic-contract",
        storageRuntimeStatus: "not-connected",
        resilienceContractStatus: "deterministic-contract",
        failoverRuntimeStatus: "not-connected",
        resourceAdapterSdkStatus: "deterministic-contract",
        secondProviderStatus: "not-connected",
        resourcePoolContractStatus: "deterministic-contract",
        partnerPoolRuntimeStatus: "not-connected",
        developmentMockAdapterAllowed: name === "development"
      });
      expect(state.execution).toMatchObject({
        jobExecutionBridgeStatus: "deterministic-contract",
        liveJobExecutionBridgeStoreStatus: "not-connected"
      });
      expect(state.composition).toEqual({
        goldenPathHarnessStatus: "deterministic-simulation-only",
        productionExecutionClaimed: false
      });
      expect(state.phase44).toEqual({
        deterministicHarnessStatus: "offline-blocking-suite",
        productionAcceptanceStatus: "not-run"
      });
      expect(state.voice.strongApprovalAllowed).toBe(false);
      expect(state.voice.rawCredentialInputAllowed).toBe(false);
    }
  });

  it("tracks evidence/manual inputs and generated outputs explicitly", () => {
    for (const sourcePath of [...registry.acceptanceEvidencePaths, ...registry.manualSourcePaths]) {
      expect(fs.existsSync(path.join(root, sourcePath))).toBe(true);
    }
    expect(registry.generatedArtifacts.machineManifest).toBe("release/out/release-manifest.json");
    expect(registry.generatedArtifacts.operatingManual).toBe("release/out/OPERATING_MANUAL.md");
  });

  it("keeps static release declarations free of raw secret-shaped values", () => {
    const content = [JSON.stringify(registry), JSON.stringify(environment)].join("\n");
    expect(content).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(content).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}\b/);
    expect(content).not.toMatch(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/);
  });
});
