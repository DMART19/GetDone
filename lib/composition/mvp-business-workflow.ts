import { z } from "zod";
import type {
  AIBudgetSnapshot,
  AIInvocationResult,
  AIRequestEnvelope
} from "@/lib/ai-gateway/contracts";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import { assertTrustedExecutionScopeEqual } from "@/lib/control-plane/trusted-execution-scope";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";

export const MVP_BUSINESS_WORKFLOW_VERSION = "1.0.0";

const proposalSchema = z.object({
  summary: z.string().min(1).max(500),
  reason: z.string().min(1).max(2_000),
  operation: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  payload: z.record(z.unknown())
}).strict();
type ProposalModelOutput = z.infer<typeof proposalSchema>;

export interface BusinessDetection {
  id: string;
  signalType: string;
  payload: Readonly<Record<string, unknown>>;
  observedAt: string;
}

export interface ProposedBusinessAction {
  id: string;
  detectionId: string;
  scope: TrustedExecutionScope;
  summary: string;
  reason: string;
  capability: "http.request";
  input: {
    companyId: string;
    operation: string;
    payload: Readonly<Record<string, unknown>>;
  };
  aiAuditHash: string;
  authorityApplied: false;
  proposedAt: string;
  proposalHash: string;
}

export interface AIReasoningGateway {
  invoke(input: {
    request: AIRequestEnvelope;
    payload: unknown;
    outputSchema: typeof proposalSchema;
    budget: AIBudgetSnapshot;
    now?: string;
  }): Promise<AIInvocationResult<ProposalModelOutput>>;
}

export interface AuthorizedBusinessActionRuntime {
  enqueueAuthorizedBusinessAction(
    job: JobRecord,
    request: AuthorizedBusinessActionRequest
  ): Promise<unknown>;
  ownerView(jobId: string, taskId: string): Promise<unknown>;
}

function assertProposal(proposal: ProposedBusinessAction) {
  const { proposalHash, ...base } = proposal;
  if (sha256Hex(base) !== proposalHash || proposal.authorityApplied !== false) {
    throw new ControlPlaneError("FORBIDDEN", "AI business-action proposal integrity failed");
  }
  return proposal;
}

export class MvpBusinessWorkflow {
  constructor(
    private readonly ai: AIReasoningGateway,
    private readonly runtime: AuthorizedBusinessActionRuntime,
    private readonly now: () => Date = () => new Date()
  ) {}

  async propose(input: {
    detection: BusinessDetection;
    scope: TrustedExecutionScope;
    budget: AIBudgetSnapshot;
  }): Promise<ProposedBusinessAction> {
    const proposedAt = this.now().toISOString();
    const result = await this.ai.invoke({
      request: {
        id: `ai-proposal:${input.detection.id}`,
        correlationId: `detection:${input.detection.id}`,
        scope: input.scope,
        inputHash: sha256Hex(input.detection),
        requestedAt: proposedAt,
        requirements: {
          role: "STANDARD",
          requiredModalities: ["text"],
          requiresTools: false,
          requiresStructuredOutput: true,
          minimumContextTokens: 8_000,
          estimatedInputTokens: 2_000,
          expectedOutputTokens: 800,
          dataClass: "INTERNAL",
          environment: input.scope.environment,
          latencyClass: "standard",
          maxCostCents: 25,
          allowFallback: true
        }
      },
      payload: {
        instruction: "Propose one configured business operation. Do not approve or execute it.",
        detection: input.detection
      },
      outputSchema: proposalSchema,
      budget: input.budget,
      now: proposedAt
    });
    if (result.kind !== "success") {
      throw new ControlPlaneError("UNAVAILABLE", `AI proposal unavailable: ${result.reason}`);
    }
    const base: Omit<ProposedBusinessAction, "proposalHash"> = {
      id: `proposal:${input.detection.id}`,
      detectionId: input.detection.id,
      scope: input.scope,
      summary: result.output.summary,
      reason: result.output.reason,
      capability: "http.request",
      input: {
        companyId: input.scope.companyId,
        operation: result.output.operation,
        payload: Object.freeze({ ...result.output.payload })
      },
      aiAuditHash: result.audit.auditHash,
      authorityApplied: false,
      proposedAt
    };
    return Object.freeze({ ...base, proposalHash: sha256Hex(base) });
  }

  enqueueAfterAuthoritativeDecision(input: {
    proposal: ProposedBusinessAction;
    job: JobRecord;
    request: AuthorizedBusinessActionRequest;
  }) {
    const proposal = assertProposal(input.proposal);
    assertTrustedExecutionScopeEqual(proposal.scope, input.request.scope, {
      requireSameResource: Boolean(proposal.scope.resourceId || input.request.scope.resourceId)
    });
    if (
      input.job.state !== "queued"
      || !input.job.authorizationGrantId
      || !input.job.authorizationGrantHash
      || !input.job.authorizationConsumption
      || input.request.jobId !== input.job.id
      || input.request.capability !== proposal.capability
      || input.request.inputHash !== sha256Hex(proposal.input)
      || input.request.authorizationConsumptionHash
        !== input.job.authorizationConsumption.consumptionHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "AI proposal cannot execute without an authoritative Decision/Grant/Task/Job chain"
      );
    }
    return this.runtime.enqueueAuthorizedBusinessAction(input.job, input.request);
  }

  ownerResult(jobId: string, taskId: string) {
    return this.runtime.ownerView(jobId, taskId);
  }
}
