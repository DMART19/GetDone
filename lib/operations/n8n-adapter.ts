import { createHmac } from "node:crypto";
import { z } from "zod";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { canonicalSerialize, sha256Hex } from "@/lib/control-plane/canonical-hash";
import { validateCapabilityInput, validateCapabilityOutput } from "@/lib/domain/capabilities";
import { assertAuthorizedBusinessActionRequest, createBusinessActionAdapterResult, createBusinessActionStatus,
  type BusinessActionAdapter, type AuthorizedBusinessActionRequest, type BusinessActionExecutionContext } from "@/lib/execution/adapters/business-action";
import { GithubStandardOperationAdapter, type GithubProviderConfiguration } from "@/lib/execution/adapters/github-standard-operation";
import { readBoundedJson, requireBrokeredCredential } from "@/lib/execution/adapters/ordinary-integration-framework";
import type { ExecutionPreview } from "./preview";
import { assertPreviewApproval } from "./preview";
import type { ApprovalProof, StepUpProof } from "@/lib/authorization/proofs";

const configSchema = z.object({
  connectionId: z.string().min(1), portfolioId: z.string().min(1), companyId: z.string().min(1),
  environment: z.enum(["development", "staging", "production"]),
  repositoryHealthUrl: z.string().url(), createBranchUrl: z.string().url()
}).strict();
export type N8nConfiguration = z.infer<typeof configSchema>;
export interface PreviewAuthority {
  preview: ExecutionPreview; currentPreview: ExecutionPreview; proof: ApprovalProof; stepUpProof?: StepUpProof;
}
export interface N8nAdapterOptions {
  fetchImpl?: typeof fetch; now?: () => Date;
  /** Must resolve the persisted Decision, preview and authorization consumption, never caller JSON. */
  authority: (request: AuthorizedBusinessActionRequest) => Promise<PreviewAuthority>;
  onEvidence?: (request: AuthorizedBusinessActionRequest, output: unknown) => Promise<void>;
  onDegraded?: (request: AuthorizedBusinessActionRequest, connectionId: string) => Promise<void>;
}
async function workflowResponse(send: () => Promise<Response>, request: AuthorizedBusinessActionRequest,
  connectionId: string, onDegraded?: N8nAdapterOptions["onDegraded"]): Promise<Response> {
  try {
    const response = await send();
    if (!response.ok) throw new Error("Workflow transport rejected request");
    return response;
  } catch {
    await onDegraded?.(request, connectionId);
    throw new ControlPlaneError("UNAVAILABLE", "The scoped n8n connection is degraded; review the connection before retrying. Completion is unverified.");
  }
}
export class N8nGithubAdapter implements BusinessActionAdapter {
  readonly id = "n8n-narrow-github";
  readonly version = "1.0.0";
  private readonly direct: GithubStandardOperationAdapter;
  private readonly configs: readonly N8nConfiguration[];
  private readonly githubConfigs: readonly GithubProviderConfiguration[];
  constructor(configs: readonly N8nConfiguration[], github: readonly GithubProviderConfiguration[],
    private readonly signingKey: string, private readonly options: N8nAdapterOptions) {
    if (signingKey.length < 32) throw new ControlPlaneError("VALIDATION_FAILED", "n8n requires a signing key of at least 32 characters");
    this.configs = configs.map(c => {
      const parsed = configSchema.parse(c);
      for (const value of [parsed.repositoryHealthUrl, parsed.createBranchUrl]) {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
          throw new ControlPlaneError("VALIDATION_FAILED", "n8n workflow URLs must be credential-free HTTPS");
      }
      return Object.freeze(parsed);
    });
    this.direct = new GithubStandardOperationAdapter(github, { fetchImpl: options.fetchImpl, now: options.now });
    this.githubConfigs = github;
  }
  credentialRequirement(request: AuthorizedBusinessActionRequest) { return this.direct.credentialRequirement(request); }
  async execute(request: AuthorizedBusinessActionRequest, context?: BusinessActionExecutionContext) {
    assertAuthorizedBusinessActionRequest(request);
    if (!["github.repository.read", "github.branch.create"].includes(request.capability))
      throw new ControlPlaneError("POLICY_BLOCKED", "This release permits only repository health reads and branch creation through n8n");
    const parameters = validateCapabilityInput<Record<string, unknown>>(request.capability, request.input);
    // Existing adapter validates brokered credential, business/environment and repository allowlist.
    this.direct.credentialRequirement(request);
    const config = this.configs.find(c => c.connectionId === parameters.connectionId && c.portfolioId === request.scope.portfolioId
      && c.companyId === request.scope.companyId && c.environment === request.scope.environment);
    if (!config) throw new ControlPlaneError("UNAVAILABLE", "Missing n8n workflow connection for this business and repository");
    const branch = request.capability === "github.branch.create";
    if (!branch && !["repository", "checks"].includes(String(parameters.operation)))
      throw new ControlPlaneError("POLICY_BLOCKED", "The repository health workflow supports repository and checks reads only");
    const github = this.githubConfigs.find(c => c.id === parameters.connectionId)!;
    const credential = requireBrokeredCredential(context, this.direct.credentialRequirement(request), request.capability);
    let previewHash: string | undefined;
    if (branch) {
      const authority = await this.options.authority(request);
      assertPreviewApproval(authority.preview, authority.currentPreview, authority.proof, request.scope,
        (this.options.now?.() ?? new Date()).getTime(), authority.stepUpProof);
      if (sha256Hex(authority.preview.parameters) !== request.inputHash || authority.preview.capability !== request.capability)
        throw new ControlPlaneError("FORBIDDEN", "Authorized job input differs from the approved dry-run preview");
      previewHash = authority.preview.previewHash;
      if (["main", "master", ...(github.protectedBranches ?? [])].includes(String(parameters.branch)))
        throw new ControlPlaneError("POLICY_BLOCKED", "n8n cannot create protected branches");
      const source = await (this.options.fetchImpl ?? fetch)(new URL(`repos/${parameters.repository}/git/ref/heads/${encodeURIComponent(String(parameters.fromRef))}`,
        github.apiBaseUrl ?? "https://api.github.com/"), { method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${credential}`, accept: "application/vnd.github+json" } });
      const output = source.ok ? await readBoundedJson(source, 200_000) as { object?: { sha?: string } } : undefined;
      if (output?.object?.sha !== parameters.expectedSourceSha)
        throw new ControlPlaneError("FORBIDDEN", "Source ref changed or cannot be independently read; prepare a new preview");
    }
    const envelope = { version: "1.0.0", requestId: request.id, jobId: request.jobId, scope: request.scope,
      capability: request.capability, parameters, inputHash: request.inputHash,
      authorizationConsumptionHash: request.authorizationConsumptionHash, previewHash, idempotencyKey: request.idempotencyKey,
      sentAt: (this.options.now?.() ?? new Date()).toISOString() };
    const body = canonicalSerialize(envelope);
    const response = await workflowResponse(() => (this.options.fetchImpl ?? fetch)(branch ? config.createBranchUrl : config.repositoryHealthUrl, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(Math.min(request.timeoutMs, 30_000)),
      headers: { "content-type": "application/json", "x-getdone-signature": createHmac("sha256", this.signingKey).update(body).digest("hex") }, body
    }), request, config.connectionId, this.options.onDegraded);
    const result = await readBoundedJson(response, 200_000);
    const observedAt = (this.options.now?.() ?? new Date()).toISOString();
    if (!branch) {
      const output = validateCapabilityOutput<{ data: unknown; dataHash: string }>(request.capability, result);
      if (output.dataHash !== sha256Hex(output.data)) throw new ControlPlaneError("FORBIDDEN", "Repository evidence content hash mismatch");
      await this.options.onEvidence?.(request, output);
      return createBusinessActionAdapterResult({ source: "business-action-adapter", requestId: request.id, adapterId: this.id,
        adapterVersion: this.version, status: "completed", output, retryable: false, observedAt });
    }
    // n8n is only a dispatch receipt. The verification identity comes from the approved scope, not its response.
    const encoded = Buffer.from(JSON.stringify({ r: parameters.repository, i: parameters.branch, e: parameters.expectedSourceSha })).toString("base64url");
    return createBusinessActionAdapterResult({ source: "business-action-adapter", requestId: request.id, adapterId: this.id,
      adapterVersion: this.version, status: "accepted", providerOperationId: `gh:${parameters.connectionId}:github.branch.create:branch:${encoded}`,
      output: { repository: parameters.repository, operation: "branch.create", providerAccepted: true,
        providerReference: parameters.expectedSourceSha, acceptedAt: observedAt }, retryable: false, observedAt });
  }
  async status(input: { requestId: string; providerOperationId: string }, context?: BusinessActionExecutionContext) {
    const status = await this.direct.status(input, context);
    return createBusinessActionStatus({ source: "business-action-adapter", ...input, adapterId: this.id, adapterVersion: this.version,
      state: status.state, observedAt: status.observedAt });
  }
}

export interface N8nDeploymentConfiguration {
  portfolioId: string; companyId: string; environment: "development" | "staging" | "production";
  operation: string; connectionId: string; workflowUrl: string;
}
export class N8nDeploymentAdapter implements BusinessActionAdapter {
  readonly id = "n8n-deployment-health";
  readonly version = "1.0.0";
  constructor(private readonly configs: readonly N8nDeploymentConfiguration[], private readonly signingKey: string,
    private readonly options: Pick<N8nAdapterOptions, "fetchImpl" | "now" | "onEvidence" | "onDegraded"> = {}) {
    if (signingKey.length < 32 || !configs.length) throw new ControlPlaneError("UNAVAILABLE", "Register the signed deployment health workflow");
    this.configs = configs.map(c => z.object({ portfolioId: z.string().min(1), companyId: z.string().min(1),
      environment: z.enum(["development", "staging", "production"]), operation: z.string().regex(/^[A-Za-z0-9._:-]+$/),
      connectionId: z.string().min(1), workflowUrl: z.string().url() }).strict().parse(c));
    for (const config of configs) {
      const url = new URL(config.workflowUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search)
        throw new ControlPlaneError("VALIDATION_FAILED", "Deployment workflow must be registered credential-free HTTPS");
    }
  }
  async execute(request: AuthorizedBusinessActionRequest) {
    assertAuthorizedBusinessActionRequest(request);
    if (request.capability !== "http.request") throw new ControlPlaneError("POLICY_BLOCKED", "Deployment health is read-only");
    const parameters = validateCapabilityInput<{ companyId: string; operation: string; payload: Record<string, unknown> }>(request.capability, request.input);
    const config = this.configs.find(c => c.portfolioId === request.scope.portfolioId && c.companyId === request.scope.companyId
      && c.environment === request.scope.environment && c.operation === parameters.operation);
    if (!config || parameters.companyId !== config.companyId || Object.keys(parameters.payload).length)
      throw new ControlPlaneError("POLICY_BLOCKED", "Only the registered deployment read with an empty payload is permitted");
    const now = (this.options.now?.() ?? new Date()).toISOString();
    const body = canonicalSerialize({ version: "1.0.0", requestId: request.id, jobId: request.jobId, scope: request.scope,
      capability: request.capability, parameters: { ...parameters, connectionId: config.connectionId },
      inputHash: request.inputHash, authorizationConsumptionHash: request.authorizationConsumptionHash,
      idempotencyKey: request.idempotencyKey, sentAt: now });
    const response = await workflowResponse(() => (this.options.fetchImpl ?? fetch)(config.workflowUrl, { method: "POST", redirect: "error",
      signal: AbortSignal.timeout(Math.min(request.timeoutMs, 30_000)), headers: { "content-type": "application/json",
        "x-getdone-signature": createHmac("sha256", this.signingKey).update(body).digest("hex") }, body }), request, config.connectionId, this.options.onDegraded);
    const result = await readBoundedJson(response, 200_000) as { output: unknown; facts: unknown };
    const output = validateCapabilityOutput(request.capability, result.output);
    await this.options.onEvidence?.(request, result);
    return createBusinessActionAdapterResult({ source: "business-action-adapter", requestId: request.id, adapterId: this.id,
      adapterVersion: this.version, status: "completed", output, retryable: false, observedAt: now });
  }
  async status(): Promise<never> { throw new ControlPlaneError("POLICY_BLOCKED", "Deployment health does not execute or poll consequential operations"); }
}
