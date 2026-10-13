import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalSerialize } from "@/lib/control-plane/canonical-hash";
import { validateN8nEnvelope } from "./n8n-envelope-validator";

const key = "n8n-test-signing-key-that-is-at-least-32-chars";
const hash = "a".repeat(64);
const baseEnv = {
  GETDONE_N8N_SIGNING_KEY: key,
  GETDONE_OWNER_USER_ID: "owner",
  GETDONE_OWNER_PORTFOLIO_ID: "portfolio",
  GETDONE_OWNER_COMPANY_ID: "company",
  GETDONE_RUNTIME_ENV: "production",
  GETDONE_GITHUB_ACTIONS_JSON: JSON.stringify([{
    id: "github-production",
    companyId: "company",
    environment: "production",
    credentialProviderId: "github-production",
    repositories: ["DMART19/GetDone"],
    protectedBranches: ["main"]
  }]),
  GETDONE_N8N_DEPLOYMENT_WORKFLOWS_JSON: JSON.stringify([{
    portfolioId: "portfolio",
    companyId: "company",
    environment: "production",
    operation: "deployment_health",
    connectionId: "deployment-production",
    workflowUrl: "https://n8n.test/webhook/deployment"
  }]),
  GETDONE_DEPLOYMENT_HEALTH_TARGET_URL: "https://getdone-web.onrender.com/api/health"
};
const envelope = () => ({
  version: "1.0.0",
  requestId: "request",
  jobId: "job",
  scope: { userId: "owner", portfolioId: "portfolio", companyId: "company", environment: "production" },
  capability: "github.repository.read",
  parameters: { companyId: "company", connectionId: "github-production", repository: "DMART19/GetDone", operation: "repository" },
  inputHash: hash,
  authorizationConsumptionHash: hash,
  idempotencyKey: "idempotency",
  sentAt: new Date().toISOString()
});
const sign = (value: unknown) => createHmac("sha256", key).update(canonicalSerialize(value)).digest("hex");

describe("n8n external envelope validator", () => {
  it("accepts a signed registered repository read", () => {
    const value = envelope();
    expect(validateN8nEnvelope(value, sign(value), baseEnv).envelope.requestId).toBe("request");
  });

  it("rejects tampering and cross-tenant scope", () => {
    const value = envelope();
    expect(() => validateN8nEnvelope({ ...value, capability: "email.send" }, sign(value), baseEnv)).toThrow(/signature/i);
    const foreign = { ...value, scope: { ...value.scope, companyId: "other" } };
    expect(() => validateN8nEnvelope(foreign, sign(foreign), baseEnv)).toThrow(/owner scope/i);
  });

  it("rejects protected branches and accepts a hash-bound test branch", () => {
    const protectedValue = { ...envelope(), capability: "github.branch.create", previewHash: hash,
      parameters: { companyId: "company", connectionId: "github-production", repository: "DMART19/GetDone",
        branch: "main", expectedSourceSha: "b".repeat(40) } };
    expect(() => validateN8nEnvelope(protectedValue, sign(protectedValue), baseEnv)).toThrow(/branch/i);
    const testBranch = { ...protectedValue, parameters: { ...protectedValue.parameters, branch: "getdone-test/acceptance" } };
    expect(validateN8nEnvelope(testBranch, sign(testBranch), baseEnv).envelope.previewHash).toBe(hash);
  });

  it("returns only the configured deployment health target for a read-only request", () => {
    const value = { ...envelope(), capability: "http.request", parameters: { companyId: "company",
      connectionId: "deployment-production", operation: "deployment_health", payload: {} } };
    expect(validateN8nEnvelope(value, sign(value), baseEnv).deploymentUrl)
      .toBe("https://getdone-web.onrender.com/api/health");
    const changed = { ...value, parameters: { ...value.parameters, payload: { url: "https://evil.test" } } };
    expect(() => validateN8nEnvelope(changed, sign(changed), baseEnv)).toThrow(/read-only/i);
  });
});
