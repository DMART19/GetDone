import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as cryptoModule from "node:crypto";
import { sha256Hex, canonicalSerialize } from "@/lib/control-plane/canonical-hash";
import { createApprovalProof } from "@/lib/authorization/proofs";
import { BusinessActionExecutionOrchestrator, type BusinessActionExecutionRecord } from "@/lib/execution/business-action-orchestrator";
import { StaticBusinessActionAdapterRegistry } from "@/lib/execution/adapters/business-action-registry";
import type { AuthorizedBusinessActionRequest, BusinessActionExecutionContext } from "@/lib/execution/adapters/business-action";
import { N8nGithubAdapter, N8nDeploymentAdapter } from "./n8n-adapter";
import { createExecutionPreview } from "./preview";
import { capabilityMap } from "./capability-map";
import type { OperationalConnection } from "./contracts";

const scope = { userId: "owner", portfolioId: "p", companyId: "c", environment: "staging" as const };
const now = "2026-10-12T18:00:00.000Z", sha = "b".repeat(40), hash = "a".repeat(64), key = "test-only-workflow-key-not-a-secret";
const github = { id: "github", companyId: "c", environment: "staging" as const, credentialProviderId: "github-provider", repositories: ["acme/app"] };
const config = { connectionId: "github", portfolioId: "p", companyId: "c", environment: "staging" as const,
  createBranchUrl: "https://n8n.test/webhook/branch", repositoryHealthUrl: "https://n8n.test/webhook/read" };
const connection: OperationalConnection = { id: "github", portfolioId: "p", companyId: "c", environment: "staging", provider: "github",
  status: "healthy", resources: ["acme/app"], workflows: ["github_create_branch", "github_repository_health"], grantedUserIds: ["owner"], updatedAt: now, sensitivity: "internal" };
const parameters = { companyId: "c", connectionId: "github", repository: "acme/app", branch: "fix-health", fromRef: "main", expectedSourceSha: sha };
function request(capability = "github.branch.create", input: unknown = parameters): AuthorizedBusinessActionRequest {
  return { id: "request", jobId: "job", scope, capability, input, inputHash: sha256Hex(input), authorizationConsumptionHash: hash,
    credentialLeaseId: "lease", idempotencyKey: "idem", timeoutMs: 5000, attempt: 1 };
}
function context(capability = "github.branch.create"): BusinessActionExecutionContext {
  return { credential: { leaseId: "lease", leaseHash: hash, providerId: "github-provider", capability, grantedScopes: ["github.read", "github.write"],
    material: "test-only-provider-material", issuedAt: now, expiresAt: "2099-01-01T00:00:00Z" } };
}
function authority() {
  const preview = createExecutionPreview({ scope, registration: capabilityMap(scope, [connection], Date.parse(now)).find(v => v.action)!, parameters,
    policy: { disposition: "APPROVAL_REQUIRED", artifactHash: hash, planHash: hash, stepHash: hash }, now, expiresAt: "2026-10-12T18:10:00.000Z" });
  const proof = createApprovalProof({ id: "proof", decisionId: "decision", approvalId: "approval", actorId: "owner", scope,
    level: "approval", previewHash: preview.previewHash, planHash: hash, stepHash: hash, grantedAt: now, expiresAt: "2026-10-12T18:09:00.000Z" });
  return { preview, currentPreview: preview, proof };
}
function harness(verifiedSha = sha) {
  const transport = vi.fn().mockImplementation(async (url: URL | string, init: RequestInit) => {
    if (String(url).includes("n8n.test")) {
      const body = String(init.body);
      expect((init.headers as Record<string, string>)["x-getdone-signature"]).toBe(createHmac("sha256", key).update(body).digest("hex"));
      expect(body).not.toContain("test-only-provider-material");
      return Response.json({ accepted: true, state: "completed" });
    }
    return Response.json({ object: { sha: String(url).includes("fix-health") ? verifiedSha : sha } });
  });
  const adapter = new N8nGithubAdapter([config], [github], key, { fetchImpl: transport as typeof fetch,
    now: () => new Date(now), authority: async () => authority() });
  let saved: BusinessActionExecutionRecord | null = null;
  const orchestrator = new BusinessActionExecutionOrchestrator(new StaticBusinessActionAdapterRegistry([{ capability: "github.branch.create", adapter }]),
    { get: async () => saved, save: async record => { saved = record; } }, { now: () => new Date(now), maxStatusPolls: 1, pollIntervalMs: 0,
      credentialBroker: { resolve: async () => context().credential! } });
  return { transport, adapter, orchestrator };
}
describe("narrow three-workflow acceptance", () => {
  it("preview -> native approval -> n8n execute -> independent GitHub verification, with replay recovery", async () => {
    const { orchestrator, transport } = harness();
    const result = await orchestrator.execute(request());
    expect(result.record.state).toBe("completed"); expect(result.verificationEvidence?.result).toBe("pass");
    const { recordHash, ...recordPayload } = result.record;
    expect(recordHash).toBe(sha256Hex(recordPayload));
    expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/repos/acme/app/git/ref/heads/main", "https://n8n.test/webhook/branch",
      "https://api.github.com/repos/acme/app/git/ref/heads/fix-health" ]);
    await orchestrator.execute(request());
    expect(transport.mock.calls.filter(([url]) => String(url).includes("n8n.test"))).toHaveLength(1);
  });
  it("n8n success is not completion when the independent branch SHA differs", async () => {
    const result = await harness("c".repeat(40)).orchestrator.execute(request());
    expect(result.record.state).toBe("running"); expect(result.verificationEvidence).toBeUndefined();
  });
  it("changed approved parameters cannot reach n8n", async () => {
    const { adapter, transport } = harness();
    await expect(adapter.execute(request("github.branch.create", { ...parameters, branch: "different" }), context())).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it("a changed source ref cannot reach n8n", async () => {
    const transport = vi.fn().mockResolvedValue(Response.json({ object: { sha: "c".repeat(40) } }));
    const adapter = new N8nGithubAdapter([config], [github], key, { fetchImpl: transport as typeof fetch, now: () => new Date(now), authority: async () => authority() });
    await expect(adapter.execute(request(), context())).rejects.toThrow("Source ref changed");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("workflow outages report the exact scoped connection as degraded without leaking provider errors", async () => {
    const degraded = vi.fn();
    const adapter = new N8nDeploymentAdapter([{ portfolioId: "p", companyId: "c", environment: "staging", operation: "deployment_health",
      connectionId: "deploy", workflowUrl: "https://n8n.test/webhook/deploy" }], key,
      { fetchImpl: vi.fn().mockRejectedValue(new Error("provider secret response")), onDegraded: degraded });
    const read = request("http.request", { companyId: "c", operation: "deployment_health", payload: {} });
    await expect(adapter.execute(read)).rejects.toThrow("scoped n8n connection is degraded");
    expect(degraded).toHaveBeenCalledWith(read, "deploy");
  });
  it("deployment health permits one scoped read-only operation and rejects arbitrary payload URLs", async () => {
    const transport = vi.fn().mockResolvedValue(Response.json({ output: { providerOperationId: "read", responseStatus: 200,
      responseBodyHash: hash, observedAt: now }, facts: { status: "healthy" } }));
    const adapter = new N8nDeploymentAdapter([{ portfolioId: "p", companyId: "c", environment: "staging", operation: "deployment_health",
      connectionId: "deploy", workflowUrl: "https://n8n.test/webhook/deploy" }], key, { fetchImpl: transport as typeof fetch });
    expect((await adapter.execute(request("http.request", { companyId: "c", operation: "deployment_health", payload: {} }))).status).toBe("completed");
    await expect(adapter.execute(request("http.request", { companyId: "c", operation: "deployment_health", payload: { url: "https://evil.test" } }))).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("repository health runs through n8n and hands dated evidence to scoped synchronization", async () => {
    const data = { open_issues_count: 2, sourceSha: sha, sourceBranch: "main" };
    const output = { repository: "acme/app", operation: "repository", data, dataHash: sha256Hex(data), observedAt: now };
    const sync = vi.fn();
    const adapter = new N8nGithubAdapter([config], [github], key, { fetchImpl: vi.fn().mockResolvedValue(Response.json(output)),
      onEvidence: sync, authority: async () => { throw new Error("Read cannot require action authority"); } });
    expect((await adapter.execute(request("github.repository.read", { companyId: "c", connectionId: "github", repository: "acme/app", operation: "repository" }), context("github.repository.read"))).status).toBe("completed");
    expect(sync).toHaveBeenCalledTimes(1);
  });
  it("all three importable workflows are inactive, signature-gated and contain no external write beyond branch creation", () => {
    for (const name of ["github_repository_health", "deployment_health", "github_create_branch"]) {
      const workflow = JSON.parse(readFileSync(`n8n/${name}.json`, "utf8"));
      expect(workflow.active).toBe(false);
      const guard = workflow.nodes.find((n: { id: string }) => n.id === "guard").parameters.jsCode;
      const receipt = workflow.nodes.find((n: { id: string }) => n.id === "receipt").parameters.jsCode;
      expect(() => new Function(guard)).not.toThrow(); expect(() => new Function(receipt)).not.toThrow();
      const envelope = { ...request(), version: "1.0.0", parameters, previewHash: authority().preview.previewHash, sentAt: new Date().toISOString() };
      const signature = createHmac("sha256", key).update(canonicalSerialize(envelope)).digest("hex");
      const sandbox = { require: () => cryptoModule, Buffer, URL, $json: { body: envelope, headers: { "x-getdone-signature": signature } },
        $env: { GETDONE_N8N_SIGNING_KEY: key, GETDONE_N8N_ALLOWED_SCOPE_JSON: JSON.stringify([{ ...scope, connectionId: "github", repositories: ["acme/app"] }]) },
        $workflow: { name }, Date };
      if (name === "github_create_branch") expect(runInNewContext(`(function(){${guard}})()`, sandbox)[0].json.envelope.parameters.branch).toBe("fix-health");
      sandbox.$json.headers["x-getdone-signature"] = "f".repeat(64);
      expect(() => runInNewContext(`(function(){${guard}})()`, sandbox)).toThrow("Invalid signature");
      expect(workflow.nodes.filter((n: { type: string; parameters: { method?: string } }) => n.type === "n8n-nodes-base.httpRequest")
        .map((n: { parameters: { method: string } }) => n.parameters.method)).toEqual(name === "github_create_branch" ? ["POST"] : name === "github_repository_health" ? ["GET", "GET"] : ["GET"]);
    }
  });
});
