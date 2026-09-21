import type { TrustedActor } from "@/lib/control-plane/request-context";
import type { StepUpProof } from "@/lib/authorization/proofs";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { AuthoritativeDecision } from "@/lib/domain/decision-service";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { VerificationRequestRecord } from "@/lib/domain/services/verification-service";
import type { Resource } from "@/lib/domain/resources";

export const CONTROL_API_SURFACE_VERSION = "1.0.0";

export interface ControlApiPrincipal {
  actor: TrustedActor;
  scope: TrustedExecutionScope;
  sessionId: string;
  /** Server-resolved evidence only. Never accept this proof from request JSON. */
  stepUpProof?: StepUpProof;
}

export interface OwnerIntentInput {
  message: string;
  channel?: "chat" | "api";
}

export interface OwnerIntentRecord {
  id: string;
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  userId: string;
  message: string;
  channel: "chat" | "api";
  status: "accepted";
  receivedAt: string;
}

export interface DecisionMutationInput {
  decisionId: string;
  action: "approve" | "modify" | "reject";
  note?: string;
  idempotencyKey: string;
}

export interface ResourceEnrollmentInput {
  id: string;
  type: Resource["type"];
  providerId?: string;
  poolId?: string;
  capabilityNames?: readonly string[];
  failureDomainIds?: readonly string[];
  credentialBindingIds?: readonly string[];
  policyBindingIds?: readonly string[];
  region?: string;
  architecture?: string;
  idempotencyKey: string;
}

export interface JobResultView {
  jobId: string;
  state: JobRecord["state"];
  verificationEvidenceIds: readonly string[];
  verificationReceiptId?: string;
  verificationReceiptHash?: string;
  verifiedCompletionFactId?: string;
  verifiedCompletionFactHash?: string;
  failureReason?: string;
}

export interface ControlApiHealth {
  service: "getdone-control-api";
  surfaceVersion: string;
  status: "ready" | "degraded" | "unavailable";
  authConnected: boolean;
  persistenceConnected: boolean;
  aiGatewayAdapterInstalled: boolean;
  durableJobStoreConnected: boolean;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ControlApiApplicationAdapter {
  authenticate(request: Request): Promise<ControlApiPrincipal>;
  health(): Promise<ControlApiHealth>;

  submitOwnerIntent(
    principal: ControlApiPrincipal,
    input: OwnerIntentInput,
    idempotencyKey: string
  ): Promise<OwnerIntentRecord>;

  listDecisions(principal: ControlApiPrincipal): Promise<readonly AuthoritativeDecision[]>;
  getDecision(principal: ControlApiPrincipal, decisionId: string): Promise<AuthoritativeDecision | null>;
  mutateDecision(
    principal: ControlApiPrincipal,
    input: DecisionMutationInput
  ): Promise<AuthoritativeDecision>;

  listResources(principal: ControlApiPrincipal): Promise<readonly Resource[]>;
  getResource(principal: ControlApiPrincipal, resourceId: string): Promise<Resource | null>;
  enrollResource(
    principal: ControlApiPrincipal,
    input: ResourceEnrollmentInput
  ): Promise<Resource>;

  listJobs(principal: ControlApiPrincipal): Promise<readonly JobRecord[]>;
  getJob(principal: ControlApiPrincipal, jobId: string): Promise<JobRecord | null>;
  getJobResult(principal: ControlApiPrincipal, jobId: string): Promise<JobResultView | null>;

  listVerifications(principal: ControlApiPrincipal): Promise<readonly VerificationRequestRecord[]>;
  getVerification(
    principal: ControlApiPrincipal,
    verificationId: string
  ): Promise<VerificationRequestRecord | null>;
}
