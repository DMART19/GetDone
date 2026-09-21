import { describe, expect, it } from "vitest";
import type { ControlApiPrincipal } from "@/lib/control-api/contracts";
import {
  NodeEnrollmentApplicationService,
  type NodeEnrollmentChallengeStore
} from "@/lib/nodes/application";
import {
  DevelopmentNodeIdentityIssuer,
  type NodeBootstrapRecord,
  type NodeEnrollmentChallengeRecord,
  type NodeIdentityCredential
} from "@/lib/nodes/identity";
import type { NodeEnrollmentCoordinator } from "@/lib/nodes/enrollment";

const principal: ControlApiPrincipal = {
  actor: { type: "user", id: "owner-a" },
  scope: {
    userId: "owner-a",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "development"
  },
  sessionId: "session-a",
  role: "owner"
};

class FakeCoordinator {
  authenticateCalls = 0;

  async identify(input: { id: string }) {
    return { id: input.id };
  }

  async createEnrollment(id: string) {
    return { id, state: "create-enrollment" };
  }

  async recordOwnerAction(id: string, _command: unknown, evidenceId: string) {
    return { id, state: "owner-action", evidenceIds: [evidenceId] };
  }

  async authenticate() {
    this.authenticateCalls += 1;
    return { state: "authenticate" };
  }

  async cancel(id: string) {
    return { id, state: "cancelled" };
  }

  async expire(id: string) {
    return { id, state: "expired" };
  }
}

class MemoryChallenges implements NodeEnrollmentChallengeStore {
  records = new Map<string, NodeEnrollmentChallengeRecord>();
  completed = new Map<string, {
    challenge: NodeEnrollmentChallengeRecord;
    node: NodeBootstrapRecord;
    credential: NodeIdentityCredential;
    replay: boolean;
  }>();

  async createChallenge(record: NodeEnrollmentChallengeRecord) {
    const existing = this.records.get(record.id);
    if (existing) return existing;
    this.records.set(record.id, record);
    return record;
  }

  async get(id: string) {
    return this.records.get(id) ?? null;
  }

  async getByTokenHash(tokenHash: string) {
    return [...this.records.values()].find((record) => record.tokenHash === tokenHash) ?? null;
  }

  async listByScope(portfolioId: string, companyId: string) {
    return [...this.records.values()].filter(
      (record) => record.portfolioId === portfolioId && record.companyId === companyId
    );
  }

  async setState(id: string, state: "expired" | "cancelled", expectedVersion: number) {
    const current = this.records.get(id)!;
    if (current.version !== expectedVersion) throw new Error("CAS");
    const next = { ...current, state, version: current.version + 1 };
    this.records.set(id, next);
    return next;
  }

  async getCompletedBootstrap(tokenHash: string, nonceHash: string) {
    const value = this.completed.get(`${tokenHash}:${nonceHash}`);
    return value ? { ...value, replay: true } : null;
  }

  async completeBootstrap(input: {
    tokenHash: string;
    nonceHash: string;
    consumedAt: string;
    node: NodeBootstrapRecord;
    credential: NodeIdentityCredential;
  }) {
    const challenge = await this.getByTokenHash(input.tokenHash);
    if (!challenge) throw new Error("missing");
    const completedChallenge: NodeEnrollmentChallengeRecord = {
      ...challenge,
      state: "consumed",
      consumedAt: input.consumedAt,
      consumedNonceHash: input.nonceHash,
      nodeId: input.node.id,
      version: challenge.version + 1
    };
    this.records.set(challenge.id, completedChallenge);
    const result = {
      challenge: completedChallenge,
      node: input.node,
      credential: input.credential,
      replay: false
    };
    this.completed.set(`${input.tokenHash}:${input.nonceHash}`, result);
    return result;
  }
}

class CountingIssuer extends DevelopmentNodeIdentityIssuer {
  issueCalls = 0;
  async issue(input: Parameters<DevelopmentNodeIdentityIssuer["issue"]>[0]) {
    this.issueCalls += 1;
    return super.issue(input);
  }
}

function createSetup(
  coordinator = new FakeCoordinator(),
  challenges = new MemoryChallenges(),
  now = new Date("2026-09-21T12:00:00Z")
) {
  const issuer = new CountingIssuer("0123456789abcdef0123456789abcdef");
  return {
    service: new NodeEnrollmentApplicationService({
      coordinator: coordinator as unknown as NodeEnrollmentCoordinator,
      challenges,
      identityIssuer: issuer,
      challengeSecret: "abcdef0123456789abcdef0123456789",
      now: () => now,
      nodeIdGenerator: () => "node-1"
    }),
    coordinator,
    challenges,
    issuer
  };
}

describe("NodeEnrollmentApplicationService", () => {
  it("creates the same bootstrap token for an idempotent owner replay", async () => {
    const { service } = createSetup();
    const input = {
      id: "enrollment-1",
      displayName: "Server",
      architecture: "x86_64" as const,
      ownerActionRequired: false,
      idempotencyKey: "owner-create-1"
    };
    const first = await service.create(principal, input);
    const second = await service.create(principal, input);
    expect(second.enrollmentToken).toBe(first.enrollmentToken);
    expect(second.challengeId).toBe(first.challengeId);
  });

  it("bootstraps once and replays the same nonce without reissuing identity", async () => {
    const setup = createSetup();
    const created = await setup.service.create(principal, {
      id: "enrollment-1",
      displayName: "Server",
      architecture: "x86_64",
      ownerActionRequired: false,
      idempotencyKey: "owner-create-1"
    });
    const request = {
      enrollmentToken: created.enrollmentToken,
      agentVersion: "0.2.0",
      protocolVersion: "1.0.0",
      architecture: "x86_64" as const,
      bootstrapPublicKey: "-----BEGIN PUBLIC KEY-----node-public-key-material-----END PUBLIC KEY-----",
      nonce: "nonce-value-that-is-long-enough"
    };
    const first = await setup.service.enrollAgent(request);
    const replay = await setup.service.enrollAgent(request);
    expect(first.nodeId).toBe("node-1");
    expect(first.replay).toBe(false);
    expect(replay.nodeId).toBe(first.nodeId);
    expect(replay.credentialId).toBe(first.credentialId);
    expect(replay.replay).toBe(true);
    expect(setup.issuer.issueCalls).toBe(1);
    expect(setup.coordinator.authenticateCalls).toBe(1);
  });

  it("rejects architecture and protocol mismatch", async () => {
    const setup = createSetup();
    const created = await setup.service.create(principal, {
      id: "enrollment-1",
      displayName: "Server",
      architecture: "arm64",
      ownerActionRequired: false,
      idempotencyKey: "owner-create-1"
    });
    await expect(setup.service.enrollAgent({
      enrollmentToken: created.enrollmentToken,
      agentVersion: "0.2.0",
      protocolVersion: "1.0.0",
      architecture: "x86_64",
      bootstrapPublicKey: "public-key-material-that-is-long-enough",
      nonce: "nonce-value-that-is-long-enough"
    })).rejects.toThrow(/owner-approved bootstrap scope/i);
    await expect(setup.service.enrollAgent({
      enrollmentToken: created.enrollmentToken,
      agentVersion: "0.2.0",
      protocolVersion: "9.0.0",
      architecture: "arm64",
      bootstrapPublicKey: "public-key-material-that-is-long-enough",
      nonce: "nonce-value-that-is-long-enough"
    })).rejects.toThrow(/protocol version/i);
  });

  it("rejects expired bootstrap challenges and cross-scope reads", async () => {
    const setup = createSetup(
      new FakeCoordinator(),
      new MemoryChallenges(),
      new Date("2026-09-21T12:00:00Z")
    );
    const created = await setup.service.create(principal, {
      id: "enrollment-1",
      displayName: "Server",
      architecture: "x86_64",
      ownerActionRequired: false,
      idempotencyKey: "owner-create-1"
    });
    const challenge = [...setup.challenges.records.values()][0];
    setup.challenges.records.set(challenge.id, {
      ...challenge,
      expiresAt: "2026-09-21T11:59:59Z"
    });
    await expect(setup.service.enrollAgent({
      enrollmentToken: created.enrollmentToken,
      agentVersion: "0.2.0",
      protocolVersion: "1.0.0",
      architecture: "x86_64",
      bootstrapPublicKey: "public-key-material-that-is-long-enough",
      nonce: "nonce-value-that-is-long-enough"
    })).rejects.toThrow(/expired/i);

    await expect(setup.service.get({
      ...principal,
      scope: { ...principal.scope, companyId: "company-b" }
    }, challenge.id)).rejects.toThrow(/not found/i);
  });

  it("delegates owner action and terminal challenge state without creating another enrollment authority", async () => {
    const setup = createSetup();
    const created = await setup.service.create(principal, {
      id: "enrollment-1",
      displayName: "Server",
      architecture: "x86_64",
      ownerActionRequired: true,
      idempotencyKey: "owner-create-1"
    });
    await expect(setup.service.ownerAction(
      principal,
      created.challengeId,
      "owner-evidence",
      "owner-action-1"
    )).resolves.toMatchObject({ state: "owner-action" });

    await expect(setup.service.cancel(
      principal,
      created.challengeId,
      "cancel-1"
    )).resolves.toMatchObject({ state: "cancelled" });
    expect((await setup.challenges.get(created.challengeId))?.state).toBe("cancelled");
  });
});
