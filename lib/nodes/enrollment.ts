import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type {
  IdentifyResourceEnrollmentInput,
  ResourceEnrollmentRecord,
  ResourceEnrollmentService
} from "@/lib/resources/enrollment";
import type {
  NodeArchitecture,
  NodeEnvironment,
  NodePlatform
} from "@/lib/nodes/contracts";

export interface NodeEnrollmentRequest {
  id: string;
  portfolioId: string;
  companyId: string;
  environment: NodeEnvironment;
  platform: NodePlatform;
  architecture: NodeArchitecture;
  ownerActionRequired: boolean;
  ownerActionDescription?: string;
  challengeToken: string;
  challengeIssuedAt?: string;
  challengeExpiresAt: string;
}

export interface NodeEnrollmentChallenge {
  enrollmentId: string;
  issuedAt: string;
  expiresAt: string;
  singleUse: true;
}

export interface NodeEnrollmentIdentityEvidence {
  evidenceId: string;
  enrollmentId: string;
  portfolioId: string;
  companyId: string;
  environment: NodeEnvironment;
  platform: NodePlatform;
  architecture: NodeArchitecture;
  observedAt: string;
}

export interface NodeEnrollmentProfile {
  evidenceId: string;
  enrollmentId: string;
  portfolioId: string;
  companyId: string;
  environment: NodeEnvironment;
  platform: NodePlatform;
  architecture: NodeArchitecture;
  inventoryHash: string;
  capabilityEvidenceIds: readonly string[];
  observedAt: string;
}

export interface NodeEnrollmentDelegate {
  identify(
    input: IdentifyResourceEnrollmentInput,
    command: AuthoritativeCommandEnvelope
  ): Promise<ResourceEnrollmentRecord>;
  createEnrollment(
    id: string,
    command: AuthoritativeCommandEnvelope
  ): Promise<ResourceEnrollmentRecord>;
  authenticate(
    id: string,
    command: AuthoritativeCommandEnvelope,
    challengeToken: string,
    evidenceId: string,
    authenticatedAt?: string
  ): Promise<ResourceEnrollmentRecord>;
  discover(
    id: string,
    command: AuthoritativeCommandEnvelope,
    evidenceId: string
  ): Promise<ResourceEnrollmentRecord>;
  profile(
    id: string,
    command: AuthoritativeCommandEnvelope,
    evidenceId: string
  ): Promise<ResourceEnrollmentRecord>;
  validate(
    id: string,
    command: AuthoritativeCommandEnvelope,
    evidenceId: string
  ): Promise<ResourceEnrollmentRecord>;
  test(
    id: string,
    command: AuthoritativeCommandEnvelope,
    evidenceId: string
  ): Promise<ResourceEnrollmentRecord>;
  register(
    id: string,
    command: AuthoritativeCommandEnvelope,
    resourceId: string,
    evidenceId: string
  ): Promise<ResourceEnrollmentRecord>;
  markReady(
    id: string,
    command: AuthoritativeCommandEnvelope
  ): Promise<ResourceEnrollmentRecord>;
}

function assertSupportedNode(platform: NodePlatform, architecture: NodeArchitecture) {
  if (platform !== "linux") {
    throw new ControlPlaneError("VALIDATION_FAILED", "Phase 28.0 supports Linux nodes only");
  }
  if (architecture !== "x86_64" && architecture !== "arm64") {
    throw new ControlPlaneError("VALIDATION_FAILED", "Unsupported authoritative node architecture");
  }
}

function assertTrustedScope(
  input: {
    portfolioId: string;
    companyId: string;
    environment: NodeEnvironment;
  },
  command: AuthoritativeCommandEnvelope
) {
  if (
    input.portfolioId !== command.scope.portfolioId
    || input.companyId !== command.scope.companyId
    || input.environment !== command.scope.environment
    || command.environment !== command.scope.environment
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Node enrollment scope must exactly match the trusted command scope"
    );
  }
}

export class NodeEnrollmentCoordinator {
  constructor(
    private readonly enrollment: NodeEnrollmentDelegate
  ) {}

  static fromResourceEnrollmentService(service: ResourceEnrollmentService) {
    return new NodeEnrollmentCoordinator(service);
  }

  identify(
    request: NodeEnrollmentRequest,
    command: AuthoritativeCommandEnvelope
  ) {
    assertSupportedNode(request.platform, request.architecture);
    assertTrustedScope(request, command);

    return this.enrollment.identify({
      id: request.id,
      requestedType: "compute",
      requestedEnvironments: [request.environment],
      ownerActionRequired: request.ownerActionRequired,
      ownerActionDescription: request.ownerActionDescription,
      challengeToken: request.challengeToken,
      challengeIssuedAt: request.challengeIssuedAt,
      challengeExpiresAt: request.challengeExpiresAt
    }, command);
  }

  createEnrollment(id: string, command: AuthoritativeCommandEnvelope) {
    return this.enrollment.createEnrollment(id, command);
  }

  authenticate(
    id: string,
    command: AuthoritativeCommandEnvelope,
    challengeToken: string,
    evidence: NodeEnrollmentIdentityEvidence
  ) {
    assertSupportedNode(evidence.platform, evidence.architecture);
    assertTrustedScope(evidence, command);
    if (evidence.enrollmentId !== id || !evidence.evidenceId) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Node identity evidence is not bound to this enrollment"
      );
    }
    return this.enrollment.authenticate(
      id,
      command,
      challengeToken,
      evidence.evidenceId,
      evidence.observedAt
    );
  }

  discover(
    id: string,
    command: AuthoritativeCommandEnvelope,
    evidenceId: string
  ) {
    return this.enrollment.discover(id, command, evidenceId);
  }

  profile(
    id: string,
    command: AuthoritativeCommandEnvelope,
    profile: NodeEnrollmentProfile
  ) {
    assertSupportedNode(profile.platform, profile.architecture);
    assertTrustedScope(profile, command);
    if (
      profile.enrollmentId !== id
      || !profile.evidenceId
      || !profile.inventoryHash
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Node profile evidence is incomplete or bound to another enrollment"
      );
    }
    return this.enrollment.profile(id, command, profile.evidenceId);
  }

  validate(
    id: string,
    command: AuthoritativeCommandEnvelope,
    evidenceId: string
  ) {
    return this.enrollment.validate(id, command, evidenceId);
  }

  test(
    id: string,
    command: AuthoritativeCommandEnvelope,
    evidenceId: string
  ) {
    return this.enrollment.test(id, command, evidenceId);
  }

  register(
    id: string,
    command: AuthoritativeCommandEnvelope,
    resourceId: string,
    evidenceId: string
  ) {
    return this.enrollment.register(id, command, resourceId, evidenceId);
  }

  markReady(id: string, command: AuthoritativeCommandEnvelope) {
    return this.enrollment.markReady(id, command);
  }
}
