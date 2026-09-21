import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { AuthoritativeCommandEnvelope } from "@/lib/control-plane/command-envelope";
import {
  ResourceEnrollmentService
} from "@/lib/resources/enrollment";
import {
  NODE_AGENT_PROTOCOL_VERSION,
  type NodeArchitecture,
  type NodeEnvironment,
  type NodePlatform
} from "@/lib/nodes/contracts";

export interface NodeEnrollmentRequest {
  id: string;
  displayName: string;
  platform: NodePlatform;
  architecture: NodeArchitecture;
  agentVersion: string;
  protocolVersion: string;
  requestedEnvironments: readonly NodeEnvironment[];
  ownerActionRequired: boolean;
  ownerActionDescription?: string;
  challengeToken: string;
  challengeIssuedAt?: string;
  challengeExpiresAt: string;
}

export interface NodeEnrollmentChallenge {
  enrollmentId: string;
  challengeToken: string;
  issuedAt: string;
  expiresAt: string;
}

export interface NodeEnrollmentIdentityEvidence {
  evidenceId: string;
  enrollmentId: string;
  portfolioId: string;
  companyId: string;
  platform: NodePlatform;
  architecture: NodeArchitecture;
  publicKeyFingerprint: string;
  observedAt: string;
}

export interface NodeEnrollmentProfile {
  evidenceId: string;
  enrollmentId: string;
  portfolioId: string;
  companyId: string;
  platform: NodePlatform;
  architecture: NodeArchitecture;
  agentVersion: string;
  protocolVersion: string;
  observedAt: string;
}

function requireText(value: string, message: string) {
  if (!value.trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", message);
  }
}

function assertSupportedProtocol(protocolVersion: string) {
  if (protocolVersion !== NODE_AGENT_PROTOCOL_VERSION) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      `Unsupported Node Agent protocol version: ${protocolVersion}`
    );
  }
}

function assertScope(
  command: AuthoritativeCommandEnvelope,
  input: {
    portfolioId: string;
    companyId: string;
    enrollmentId: string;
  },
  enrollmentId: string
) {
  if (
    input.enrollmentId !== enrollmentId
    || input.portfolioId !== command.scope.portfolioId
    || input.companyId !== command.scope.companyId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Node enrollment evidence does not match trusted command scope"
    );
  }
}

export class NodeEnrollmentCoordinator {
  constructor(private readonly resourceEnrollment: ResourceEnrollmentService) {}

  identify(
    input: NodeEnrollmentRequest,
    command: AuthoritativeCommandEnvelope
  ) {
    requireText(input.displayName, "Node display name is required");
    requireText(input.agentVersion, "Node Agent version is required");
    assertSupportedProtocol(input.protocolVersion);

    if (input.platform !== "linux") {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Phase 28.0 only supports Linux compute nodes"
      );
    }
    if (input.architecture !== "x86_64" && input.architecture !== "arm64") {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Node architecture is not supported"
      );
    }
    if (
      input.requestedEnvironments.length !== 1
      || input.requestedEnvironments[0] !== command.scope.environment
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Node enrollment cannot exceed trusted environment scope"
      );
    }

    return this.resourceEnrollment.identify({
      id: input.id,
      requestedType: "compute",
      requestedEnvironments: [...input.requestedEnvironments],
      ownerActionRequired: input.ownerActionRequired,
      ownerActionDescription: input.ownerActionDescription,
      challengeToken: input.challengeToken,
      challengeIssuedAt: input.challengeIssuedAt,
      challengeExpiresAt: input.challengeExpiresAt
    }, command);
  }

  createEnrollment(id: string, command: AuthoritativeCommandEnvelope) {
    return this.resourceEnrollment.createEnrollment(id, command);
  }

  recordOwnerAction(
    id: string,
    command: AuthoritativeCommandEnvelope,
    evidenceId: string
  ) {
    return this.resourceEnrollment.recordOwnerAction(id, command, evidenceId);
  }

  authenticate(
    id: string,
    command: AuthoritativeCommandEnvelope,
    challengeToken: string,
    evidence: NodeEnrollmentIdentityEvidence,
    authenticatedAt?: string
  ) {
    assertScope(command, evidence, id);
    requireText(evidence.evidenceId, "Node identity evidence ID is required");
    requireText(
      evidence.publicKeyFingerprint,
      "Node identity public key fingerprint is required"
    );
    if (evidence.platform !== "linux") {
      throw new ControlPlaneError("FORBIDDEN", "Node identity platform is unsupported");
    }
    if (evidence.architecture !== "x86_64" && evidence.architecture !== "arm64") {
      throw new ControlPlaneError("FORBIDDEN", "Node identity architecture is unsupported");
    }

    return this.resourceEnrollment.authenticate(
      id,
      command,
      challengeToken,
      evidence.evidenceId,
      authenticatedAt
    );
  }

  discover(
    id: string,
    command: AuthoritativeCommandEnvelope,
    evidenceId: string
  ) {
    return this.resourceEnrollment.discover(id, command, evidenceId);
  }

  profile(
    id: string,
    command: AuthoritativeCommandEnvelope,
    profile: NodeEnrollmentProfile
  ) {
    assertScope(command, profile, id);
    requireText(profile.evidenceId, "Node profile evidence ID is required");
    requireText(profile.agentVersion, "Node Agent version is required");
    assertSupportedProtocol(profile.protocolVersion);
    if (profile.platform !== "linux") {
      throw new ControlPlaneError("FORBIDDEN", "Node profile platform is unsupported");
    }
    if (profile.architecture !== "x86_64" && profile.architecture !== "arm64") {
      throw new ControlPlaneError("FORBIDDEN", "Node profile architecture is unsupported");
    }
    return this.resourceEnrollment.profile(id, command, profile.evidenceId);
  }

  validate(
    id: string,
    command: AuthoritativeCommandEnvelope,
    evidenceId: string
  ) {
    return this.resourceEnrollment.validate(id, command, evidenceId);
  }

  test(
    id: string,
    command: AuthoritativeCommandEnvelope,
    evidenceId: string
  ) {
    return this.resourceEnrollment.test(id, command, evidenceId);
  }

  register(
    id: string,
    command: AuthoritativeCommandEnvelope,
    resourceId: string,
    evidenceId: string
  ) {
    return this.resourceEnrollment.register(
      id,
      command,
      resourceId,
      evidenceId
    );
  }

  markReady(id: string, command: AuthoritativeCommandEnvelope) {
    return this.resourceEnrollment.markReady(id, command);
  }
}
