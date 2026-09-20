import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_POLICY_VERSION } from "@/lib/domain/policy-registry";
import { POLICY_ENGINE_VERSION } from "@/lib/planning/policy-engine";
import { AI_GATEWAY_CONTRACT_VERSION, AI_ROUTING_POLICY_CONTRACT_VERSION } from "@/lib/ai-gateway/contracts";
import { INTEGRATION_REGISTRY_CONTRACT_VERSION } from "@/lib/integrations/contracts";
import { JOB_RUNTIME_CONTRACT_VERSION } from "@/lib/execution/job-runtime-contracts";
import { BUSINESS_ACTION_ADAPTER_CONTRACT_VERSION } from "@/lib/execution/adapters/business-action";
import { SOFTWARE_WORKER_CONTRACT_VERSION } from "@/lib/execution/software-worker";

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
  database: { status: string; migrationVersion: string; schemaVersion: string };
  aiGateway: {
    contractVersion: string;
    routingPolicyContractVersion: string;
    status: string;
    adapterVersion: string;
    routingPolicyVersion: string;
  };
  integrations: {
    registryContractVersion: string;
    liveAdaptersStatus: string;
  };
  execution: {
    jobRuntimeContractVersion: string;
    durableJobStoreStatus: string;
    businessActionContractVersion: string;
    businessAdaptersStatus: string;
    softwareWorkerContractVersion: string;
    softwareDeploymentStatus: string;
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
  aiGateway: { contractStatus: string; adapterStatus: string; routingPolicyStatus: string; provider: string };
  integrations: { registryStatus: string; adapterStatus: string; mockAllowed: boolean };
  execution: {
    jobRuntimeContractStatus: string;
    durableJobStoreStatus: string;
    businessActionAdapterStatus: string;
    softwareDeploymentStatus: string;
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
    expect(registry.registrySchemaVersion).toBe("1.2.0");
    expect(registry.environmentManifestSchemaVersion).toBe("1.2.0");
    expect(environment.manifestSchemaVersion).toBe("1.2.0");
    expect(registry.schemaVersions.releaseManifest.version).toBe("1.2.0");
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

  it("records deterministic Phase 13 contracts without inventing a live AI provider", () => {
    expect(registry.aiGateway).toMatchObject({
      contractVersion: AI_GATEWAY_CONTRACT_VERSION,
      routingPolicyContractVersion: AI_ROUTING_POLICY_CONTRACT_VERSION,
      status: "not-connected",
      adapterVersion: "UNIMPLEMENTED",
      routingPolicyVersion: "UNCONFIGURED"
    });
    expect(registry.adapters.aiGateway.status).toBe("contract-only");
  });

  it("records deterministic Phase 4 and Phase 19-21 contracts without live adapters/stores", () => {
    expect(registry.integrations).toMatchObject({
      registryContractVersion: INTEGRATION_REGISTRY_CONTRACT_VERSION,
      liveAdaptersStatus: "not-connected"
    });
    expect(registry.execution).toMatchObject({
      jobRuntimeContractVersion: JOB_RUNTIME_CONTRACT_VERSION,
      durableJobStoreStatus: "not-connected",
      businessActionContractVersion: BUSINESS_ACTION_ADAPTER_CONTRACT_VERSION,
      businessAdaptersStatus: "not-connected",
      softwareWorkerContractVersion: SOFTWARE_WORKER_CONTRACT_VERSION,
      softwareDeploymentStatus: "not-connected"
    });
    expect(registry.adapters.businessAction.status).toBe("contract-only");
    expect(registry.adapters.integration.status).toBe("contract-only");
    expect(registry.adapters.softwareDeployment.status).toBe("contract-only");
  });

  it("records the exact absence of database migrations instead of inventing schema state", () => {
    expect(registry.database.status).toBe("not-connected");
    expect(registry.database.migrationVersion).toBe("UNIMPLEMENTED");
    expect(registry.database.schemaVersion).toBe("UNIMPLEMENTED");
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
    expect(Object.keys(environment.environments).sort()).toEqual(["development", "production", "staging"]);
    expect(environment.environments.production.productionReady).toBe(false);
    expect(environment.environments.production.deployment.status).toBe("not-connected");
    for (const [name, state] of Object.entries(environment.environments)) {
      expect(state.connections.aiGateway).toBe(false);
      expect(state.connections.durableJobEngine).toBe(false);
      expect(state.connections.businessIntegrationAdapters).toBe(false);
      expect(state.connections.businessActionAdapters).toBe(false);
      expect(state.connections.softwareDeploymentExecutor).toBe(false);
      expect(state.aiGateway).toMatchObject({
        contractStatus: "deterministic-contract",
        adapterStatus: "not-connected",
        routingPolicyStatus: "unconfigured",
        provider: "UNCONFIGURED"
      });
      expect(state.integrations.registryStatus).toBe("deterministic-contract");
      expect(state.integrations.adapterStatus).toBe("not-connected");
      expect(state.integrations.mockAllowed).toBe(name === "development");
      expect(state.execution).toMatchObject({
        jobRuntimeContractStatus: "deterministic-contract",
        durableJobStoreStatus: "not-connected",
        businessActionAdapterStatus: "not-connected",
        softwareDeploymentStatus: "not-connected"
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
