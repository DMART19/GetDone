import { describe, expect, it } from "vitest";
import { createCompanyIntegration, beginIntegrationAuthentication, activateIntegration, deactivateIntegration, assertIntegrationUsable } from "@/lib/integrations/registry";
import { DevelopmentMockIntegrationAdapter } from "@/lib/integrations/development-mock-adapter";

const scope = {
  userId: "owner",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "development" as const
};

async function connected() {
  const created = createCompanyIntegration({
    id: "github-a",
    scope,
    kind: "github",
    displayName: "GitHub",
    adapterId: "development-mock-integration",
    adapterVersion: "1.0.0",
    credentialBindingId: "credential-binding-github-a",
    readScopes: ["repository.read"],
    writeScopes: ["repository.write"],
    mock: true,
    createdAt: "2026-09-20T22:00:00Z"
  });
  const authenticating = beginIntegrationAuthentication(created, scope, "2026-09-20T22:00:01Z");
  const adapter = new DevelopmentMockIntegrationAdapter();
  const evidence = await adapter.authenticate({
    integration: authenticating,
    credentialBindingId: authenticating.credentialBindingId
  });
  return activateIntegration({
    record: authenticating,
    scope,
    evidence,
    activatedAt: "2026-09-20T22:00:02Z"
  });
}

describe("Phase 4 deterministic Integration Registry", () => {
  it("keeps read and write permissions explicit and separate", async () => {
    const record = await connected();
    expect(assertIntegrationUsable({
      record,
      scope,
      access: "read",
      requiredScope: "repository.read"
    })).toBe(record);
    expect(() => assertIntegrationUsable({
      record,
      scope,
      access: "write",
      requiredScope: "repository.read"
    })).toThrow(/required access scope/i);
  });

  it("fails tenant scope tampering", async () => {
    const record = await connected();
    expect(() => assertIntegrationUsable({
      record,
      scope: { ...scope, companyId: "company-b" },
      access: "read",
      requiredScope: "repository.read"
    })).toThrow(/outside trusted/i);
  });

  it("cannot activate from provider evidence that changes company lineage", async () => {
    const created = createCompanyIntegration({
      id: "slack-a",
      scope,
      kind: "slack",
      displayName: "Slack",
      adapterId: "development-mock-integration",
      adapterVersion: "1.0.0",
      credentialBindingId: "credential-binding-slack-a",
      readScopes: ["messages.read"],
      createdAt: "2026-09-20T22:00:00Z",
      mock: true
    });
    const authenticating = beginIntegrationAuthentication(created, scope, "2026-09-20T22:00:01Z");
    const adapter = new DevelopmentMockIntegrationAdapter();
    const evidence = await adapter.authenticate({
      integration: authenticating,
      credentialBindingId: authenticating.credentialBindingId
    });
    const tampered = { ...evidence, companyId: "company-b" };
    expect(() => activateIntegration({
      record: authenticating,
      scope,
      evidence: tampered,
      activatedAt: "2026-09-20T22:00:02Z"
    })).toThrow();
  });

  it("uses credential references and rejects raw credential-shaped values", () => {
    expect(() => createCompanyIntegration({
      id: "github-secret",
      scope,
      kind: "github",
      displayName: "GitHub",
      adapterId: "adapter",
      adapterVersion: "1.0.0",
      credentialBindingId: "Bearer " + "x".repeat(28),
      createdAt: "2026-09-20T22:00:00Z"
    })).toThrow(/reference/i);
  });

  it("deactivation removes usability without deleting history", async () => {
    const record = await connected();
    const disabled = deactivateIntegration(record, scope, "2026-09-20T22:05:00Z");
    expect(disabled.state).toBe("disabled");
    expect(disabled.id).toBe(record.id);
    expect(() => assertIntegrationUsable({
      record: disabled,
      scope,
      access: "read",
      requiredScope: "repository.read"
    })).toThrow(/not connected/i);
  });

  it("mock adapters fail outside development", async () => {
    const productionScope = { ...scope, environment: "production" as const };
    const record = createCompanyIntegration({
      id: "mock-prod",
      scope: productionScope,
      kind: "rest-api",
      displayName: "Mock",
      adapterId: "development-mock-integration",
      adapterVersion: "1.0.0",
      mock: true,
      createdAt: "2026-09-20T22:00:00Z"
    });
    const adapter = new DevelopmentMockIntegrationAdapter();
    await expect(adapter.authenticate({ integration: record })).rejects.toThrow(/DEVELOPMENT-only/);
  });
});
