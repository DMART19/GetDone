import { createHmac } from "node:crypto";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { createCorrelationId } from "@/lib/control-plane/request-context";
import { canonicalSerialize, sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { ControlApiPrincipal } from "@/lib/control-api/contracts";
import {
  NODE_AGENT_PROTOCOL_VERSION,
  type NodeArchitecture
} from "@/lib/nodes/contracts";
import {
  NodeEnrollmentCoordinator
} from "@/lib/nodes/enrollment";
import {
  type NodeBootstrapRecord,
  type NodeEnrollmentChallengeRecord,
  type NodeIdentityCredential,
  type NodeIdentityIssuer
} from "@/lib/nodes/identity";
import { hashEnrollmentChallenge } from "@/lib/resources/enrollment";

export const NODE_ENROLLMENT_APPLICATION_VERSION = "1.0.0";

export interface CreateNodeEnrollmentInput {
  id: string;
  displayName: string;
  architecture: NodeArchitecture;
  ownerActionRequired: boolean;
  ownerActionDescription?: string;
  idempotencyKey: string;
}

export interface NodeEnrollmentCreateResult {
  enrollmentId: string;
  challengeId: string;
  enrollmentToken: string;
  architecture: NodeArchitecture;
  expiresAt: string;
}

export interface AgentNodeEnrollmentInput {
  enrollmentToken: string;
  agentVersion: string;
  protocolVersion: string;
  architecture: NodeArchitecture;
  bootstrapPublicKey: string;
  nonce: string;
}

export interface AgentNodeEnrollmentResult {
  nodeId: string;
  credentialId: string;
  identityCertificate: string;
  certificateChain: string;
  controlPlaneIdentity: {
    nodeId: string;
    portfolioId: string;
    companyId: string;
  };
  configuration: {
    protocolVersion: string;
  };
  replay: boolean;
}

export interface NodeEnrollmentChallengeStore {
  createChallenge(record: NodeEnrollmentChallengeRecord): Promise<NodeEnrollmentChallengeRecord>;
  get(id: string): Promise<NodeEnrollmentChallengeRecord | null>;
  getByTokenHash(tokenHash: string): Promise<NodeEnrollmentChallengeRecord | null>;
  listByScope(
    portfolioId: string,
    companyId: string
  ): Promise<readonly NodeEnrollmentChallengeRecord[]>;
  setState(
    id: string,
    state: "expired" | "cancelled",
    expectedVersion: number
  ): Promise<NodeEnrollmentChallengeRecord>;
  getCompletedBootstrap(
    tokenHash: string,
    nonceHash: string
  ): Promise<{
    challenge: NodeEnrollmentChallengeRecord;
    node: NodeBootstrapRecord;
    credential: NodeIdentityCredential;
    replay: boolean;
  } | null>;
  completeBootstrap(input: {
    tokenHash: string;
    nonceHash: string;
    consumedAt: string;
    node: NodeBootstrapRecord;
    credential: NodeIdentityCredential;
  }): Promise<{
    challenge: NodeEnrollmentChallengeRecord;
    node: NodeBootstrapRecord;
    credential: NodeIdentityCredential;
    replay: boolean;
  }>;
}

export interface NodeScopedReadStore<T> {
  get(id: string): Promise<T | null>;
  listByScope(portfolioId: string, companyId: string): Promise<readonly T[]>;
}

export interface NodeEnrollmentApplicationAdapter {
  list(principal: ControlApiPrincipal): Promise<readonly NodeEnrollmentChallengeRecord[]>;
  get(
    principal: ControlApiPrincipal,
    id: string
  ): Promise<NodeEnrollmentChallengeRecord | null>;
  create(
    principal: ControlApiPrincipal,
    input: CreateNodeEnrollmentInput
  ): Promise<NodeEnrollmentCreateResult>;
  ownerAction(
    principal: ControlApiPrincipal,
    challengeId: string,
    evidenceId: string,
    idempotencyKey: string
  ): Promise<unknown>;
  cancel(
    principal: ControlApiPrincipal,
    challengeId: string,
    idempotencyKey: string
  ): Promise<unknown>;
  expire(
    principal: ControlApiPrincipal,
    challengeId: string,
    idempotencyKey: string
  ): Promise<unknown>;
  enrollAgent(input: AgentNodeEnrollmentInput): Promise<AgentNodeEnrollmentResult>;
}

export interface NodeEnrollmentApplicationDependencies {
  coordinator: NodeEnrollmentCoordinator;
  challenges: NodeEnrollmentChallengeStore;
  identityIssuer: NodeIdentityIssuer;
  now?: () => Date;
  challengeSecret: string | Buffer;
  nodeIdGenerator?: () => string;
}

function assertPrincipalScope(
  principal: ControlApiPrincipal,
  challenge: NodeEnrollmentChallengeRecord
) {
  if (
    challenge.portfolioId !== principal.scope.portfolioId
    || challenge.companyId !== principal.scope.companyId
    || challenge.ownerUserId !== principal.scope.userId
    || challenge.environment !== principal.scope.environment
  ) {
    throw new ControlPlaneError("NOT_FOUND", "Node enrollment was not found");
  }
}

function requireFutureExpiry(expiresAt: string, now: Date) {
  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed) || parsed <= now.getTime()) {
    throw new ControlPlaneError("FORBIDDEN", "Node enrollment challenge has expired");
  }
}

export class NodeEnrollmentApplicationService implements NodeEnrollmentApplicationAdapter {
  private readonly now: () => Date;
  private readonly challengeSecret: Buffer;
  private readonly nodeIdGenerator: () => string;

  constructor(private readonly deps: NodeEnrollmentApplicationDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.challengeSecret = Buffer.isBuffer(deps.challengeSecret)
      ? Buffer.from(deps.challengeSecret)
      : Buffer.from(deps.challengeSecret);
    if (this.challengeSecret.length < 32) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Node enrollment challenge secret must be at least 32 bytes"
      );
    }
    this.nodeIdGenerator = deps.nodeIdGenerator
      ?? (() => `node-${crypto.randomUUID()}`);
  }

  async list(principal: ControlApiPrincipal) {
    const records = await this.deps.challenges.listByScope(
      principal.scope.portfolioId,
      principal.scope.companyId
    );
    return records.filter((record) =>
      record.ownerUserId === principal.scope.userId
      && record.environment === principal.scope.environment
    );
  }

  async get(principal: ControlApiPrincipal, id: string) {
    const challenge = await this.deps.challenges.get(id);
    if (!challenge) return null;
    assertPrincipalScope(principal, challenge);
    return challenge;
  }

  async create(
    principal: ControlApiPrincipal,
    input: CreateNodeEnrollmentInput
  ): Promise<NodeEnrollmentCreateResult> {
    const now = this.now();
    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
    const enrollmentToken = this.deriveEnrollmentToken(principal, input);

    const identified = await this.deps.coordinator.identify({
      id: input.id,
      displayName: input.displayName,
      platform: "linux",
      architecture: input.architecture,
      agentVersion: "unreported",
      protocolVersion: NODE_AGENT_PROTOCOL_VERSION,
      requestedEnvironments: [principal.scope.environment],
      ownerActionRequired: input.ownerActionRequired,
      ownerActionDescription: input.ownerActionDescription,
      challengeToken: enrollmentToken,
      challengeIssuedAt: issuedAt,
      challengeExpiresAt: expiresAt
    }, createCommandEnvelope({
      commandId: crypto.randomUUID(),
      actor: principal.actor,
      scope: principal.scope,
      correlationId: createCorrelationId(),
      environment: principal.scope.environment,
      idempotencyKey: input.idempotencyKey,
      provenance: "node-control-api:enrollment-create",
      requestedMutation: {
        type: "node-enrollment.identify",
        enrollmentId: input.id
      }
    }));

    await this.deps.coordinator.createEnrollment(
      identified.id,
      createCommandEnvelope({
        commandId: crypto.randomUUID(),
        actor: principal.actor,
        scope: principal.scope,
        correlationId: createCorrelationId(),
        environment: principal.scope.environment,
        idempotencyKey: `${input.idempotencyKey}:create`,
        provenance: "node-control-api:enrollment-create",
        requestedMutation: {
          type: "node-enrollment.create",
          enrollmentId: input.id
        }
      })
    );

    const challenge: NodeEnrollmentChallengeRecord = Object.freeze({
      id: `node-challenge-${input.id}`,
      resourceEnrollmentId: identified.id,
      portfolioId: principal.scope.portfolioId,
      companyId: principal.scope.companyId,
      ownerUserId: principal.scope.userId,
      environment: principal.scope.environment,
      displayName: input.displayName,
      platform: "linux",
      architecture: input.architecture,
      protocolVersion: NODE_AGENT_PROTOCOL_VERSION,
      tokenHash: hashEnrollmentChallenge(enrollmentToken),
      state: "pending",
      issuedAt,
      expiresAt,
      version: 1
    });
    const persisted = await this.deps.challenges.createChallenge(challenge);

    return {
      enrollmentId: identified.id,
      challengeId: persisted.id,
      enrollmentToken,
      architecture: input.architecture,
      expiresAt
    };
  }

  async ownerAction(
    principal: ControlApiPrincipal,
    challengeId: string,
    evidenceId: string,
    idempotencyKey: string
  ) {
    const challenge = await this.requireOwnedChallenge(principal, challengeId);
    return this.deps.coordinator.recordOwnerAction(
      challenge.resourceEnrollmentId,
      createCommandEnvelope({
        commandId: crypto.randomUUID(),
        actor: principal.actor,
        scope: principal.scope,
        correlationId: createCorrelationId(),
        environment: principal.scope.environment,
        idempotencyKey,
        provenance: "node-control-api:owner-action",
        requestedMutation: {
          type: "node-enrollment.owner-action",
          enrollmentId: challenge.resourceEnrollmentId
        }
      }),
      evidenceId
    );
  }

  async cancel(
    principal: ControlApiPrincipal,
    challengeId: string,
    idempotencyKey: string
  ) {
    const challenge = await this.requireOwnedChallenge(principal, challengeId);
    const record = await this.deps.coordinator.cancel(
      challenge.resourceEnrollmentId,
      this.commandFromChallenge(principal, challenge, idempotencyKey, "cancel")
    );
    await this.deps.challenges.setState(challenge.id, "cancelled", challenge.version);
    return record;
  }

  async expire(
    principal: ControlApiPrincipal,
    challengeId: string,
    idempotencyKey: string
  ) {
    const challenge = await this.requireOwnedChallenge(principal, challengeId);
    const record = await this.deps.coordinator.expire(
      challenge.resourceEnrollmentId,
      this.commandFromChallenge(principal, challenge, idempotencyKey, "expire")
    );
    await this.deps.challenges.setState(challenge.id, "expired", challenge.version);
    return record;
  }

  async enrollAgent(input: AgentNodeEnrollmentInput): Promise<AgentNodeEnrollmentResult> {
    if (input.protocolVersion !== NODE_AGENT_PROTOCOL_VERSION) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Node Agent protocol version is not supported"
      );
    }
    const tokenHash = hashEnrollmentChallenge(input.enrollmentToken);
    const nonceHash = sha256Hex(input.nonce);

    const replay = await this.deps.challenges.getCompletedBootstrap(tokenHash, nonceHash);
    if (replay) return this.bootstrapResult(replay);

    const challenge = await this.deps.challenges.getByTokenHash(tokenHash);
    if (!challenge) {
      throw new ControlPlaneError("UNAUTHENTICATED", "Node enrollment token is invalid");
    }
    if (challenge.state !== "pending") {
      throw new ControlPlaneError(
        "FORBIDDEN",
        `Node enrollment challenge is ${challenge.state}`
      );
    }
    const now = this.now();
    requireFutureExpiry(challenge.expiresAt, now);
    if (
      challenge.platform !== "linux"
      || challenge.architecture !== input.architecture
      || challenge.protocolVersion !== input.protocolVersion
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Node enrollment identity does not match the owner-approved bootstrap scope"
      );
    }

    const nodeId = this.nodeIdGenerator();
    const observedAt = now.toISOString();
    const publicKeyFingerprint = sha256Hex(input.bootstrapPublicKey);
    const command = createCommandEnvelope({
      commandId: crypto.randomUUID(),
      actor: { type: "system", id: "node-bootstrap" },
      scope: {
        userId: challenge.ownerUserId,
        portfolioId: challenge.portfolioId,
        companyId: challenge.companyId,
        environment: challenge.environment
      },
      correlationId: createCorrelationId(),
      environment: challenge.environment,
      idempotencyKey: `node-bootstrap:${challenge.id}:${nonceHash}`,
      provenance: "node-agent:bootstrap",
      requestedMutation: {
        type: "node-enrollment.authenticate",
        enrollmentId: challenge.resourceEnrollmentId
      }
    });

    await this.deps.coordinator.authenticate(
      challenge.resourceEnrollmentId,
      command,
      input.enrollmentToken,
      {
        evidenceId: `node-identity-${challenge.id}-${nonceHash.slice(0, 16)}`,
        enrollmentId: challenge.resourceEnrollmentId,
        portfolioId: challenge.portfolioId,
        companyId: challenge.companyId,
        platform: "linux",
        architecture: input.architecture,
        publicKeyFingerprint,
        observedAt
      },
      observedAt
    );

    const credential = await this.deps.identityIssuer.issue({
      nodeId,
      portfolioId: challenge.portfolioId,
      companyId: challenge.companyId,
      publicKey: input.bootstrapPublicKey,
      issuedAt: observedAt,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString()
    });

    const node: NodeBootstrapRecord = Object.freeze({
      id: nodeId,
      portfolioId: challenge.portfolioId,
      companyId: challenge.companyId,
      ownerUserId: challenge.ownerUserId,
      resourceEnrollmentId: challenge.resourceEnrollmentId,
      displayName: challenge.displayName,
      platform: challenge.platform,
      architecture: challenge.architecture,
      agentVersion: input.agentVersion,
      protocolVersion: input.protocolVersion,
      lifecycleState: "authenticated",
      version: 1,
      createdAt: observedAt,
      updatedAt: observedAt
    });

    try {
      const completed = await this.deps.challenges.completeBootstrap({
        tokenHash,
        nonceHash,
        consumedAt: observedAt,
        node,
        credential
      });
      return this.bootstrapResult(completed);
    } catch (error) {
      await this.deps.identityIssuer.revoke(
        credential,
        "bootstrap-persistence-failed",
        this.now().toISOString()
      ).catch(() => undefined);
      throw error;
    }
  }

  private deriveEnrollmentToken(
    principal: ControlApiPrincipal,
    input: CreateNodeEnrollmentInput
  ) {
    return createHmac("sha256", this.challengeSecret)
      .update(canonicalSerialize({
        userId: principal.scope.userId,
        portfolioId: principal.scope.portfolioId,
        companyId: principal.scope.companyId,
        environment: principal.scope.environment,
        enrollmentId: input.id,
        architecture: input.architecture,
        idempotencyKey: input.idempotencyKey
      }))
      .digest("base64url");
  }

  private bootstrapResult(input: {
    node: NodeBootstrapRecord;
    credential: NodeIdentityCredential;
    replay: boolean;
  }): AgentNodeEnrollmentResult {
    return {
      nodeId: input.node.id,
      credentialId: input.credential.id,
      identityCertificate: input.credential.certificatePem,
      certificateChain: input.credential.certificateChainPem,
      controlPlaneIdentity: {
        nodeId: input.node.id,
        portfolioId: input.node.portfolioId,
        companyId: input.node.companyId
      },
      configuration: {
        protocolVersion: input.node.protocolVersion
      },
      replay: input.replay
    };
  }

  private async requireOwnedChallenge(
    principal: ControlApiPrincipal,
    id: string
  ) {
    const challenge = await this.deps.challenges.get(id);
    if (!challenge) throw new ControlPlaneError("NOT_FOUND", "Node enrollment was not found");
    assertPrincipalScope(principal, challenge);
    return challenge;
  }

  private commandFromChallenge(
    principal: ControlApiPrincipal,
    challenge: NodeEnrollmentChallengeRecord,
    idempotencyKey: string,
    action: string
  ) {
    return createCommandEnvelope({
      commandId: crypto.randomUUID(),
      actor: principal.actor,
      scope: principal.scope,
      correlationId: createCorrelationId(),
      environment: principal.scope.environment,
      idempotencyKey,
      provenance: "node-control-api:enrollment-action",
      requestedMutation: {
        type: `node-enrollment.${action}`,
        enrollmentId: challenge.resourceEnrollmentId
      }
    });
  }
}
