import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  NodeArchitecture,
  NodeEnvironment,
  NodePlatform
} from "@/lib/nodes/contracts";

export const NODE_IDENTITY_CONTRACT_VERSION = "1.0.0";

export type NodeEnrollmentChallengeState =
  | "pending"
  | "consumed"
  | "expired"
  | "cancelled";

export interface NodeBootstrapRecord {
  id: string;
  portfolioId: string;
  companyId: string;
  ownerUserId: string;
  resourceEnrollmentId: string;
  resourceId?: string;
  displayName: string;
  platform: NodePlatform;
  architecture: NodeArchitecture;
  agentVersion: string;
  protocolVersion: string;
  lifecycleState: "authenticated";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface NodeEnrollmentChallengeRecord {
  id: string;
  resourceEnrollmentId: string;
  portfolioId: string;
  companyId: string;
  ownerUserId: string;
  environment: NodeEnvironment;
  displayName: string;
  platform: NodePlatform;
  architecture: NodeArchitecture;
  protocolVersion: string;
  tokenHash: string;
  state: NodeEnrollmentChallengeState;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
  consumedNonceHash?: string;
  nodeId?: string;
  version: number;
}

export interface NodeIdentityCredential {
  id: string;
  nodeId: string;
  serialNumber: string;
  publicKeyFingerprint: string;
  certificatePem: string;
  certificateChainPem: string;
  credentialHash: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  revocationReason?: string;
  version: number;
}

export interface NodeIdentityIssueRequest {
  nodeId: string;
  portfolioId: string;
  companyId: string;
  publicKey: string;
  issuedAt: string;
  expiresAt: string;
}

export interface NodeIdentityIssuer {
  issue(request: NodeIdentityIssueRequest): Promise<NodeIdentityCredential>;
  rotate(
    current: NodeIdentityCredential,
    request: NodeIdentityIssueRequest
  ): Promise<NodeIdentityCredential>;
  revoke(
    credential: NodeIdentityCredential,
    reason: string,
    revokedAt: string
  ): Promise<void>;
  verify(credential: NodeIdentityCredential): Promise<boolean>;
}

interface DevelopmentCredentialPayload {
  nodeId: string;
  portfolioId: string;
  companyId: string;
  serialNumber: string;
  publicKeyFingerprint: string;
  issuedAt: string;
  expiresAt: string;
  issuer: "getdone-development-node-ca";
}

function developmentCertificate(payload: DevelopmentCredentialPayload, secret: Buffer) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return [
    "-----BEGIN GETDONE DEVELOPMENT NODE CERTIFICATE-----",
    encoded,
    signature,
    "-----END GETDONE DEVELOPMENT NODE CERTIFICATE-----"
  ].join("\n");
}

function parseDevelopmentCertificate(value: string) {
  const lines = value.trim().split("\n");
  if (
    lines.length !== 4
    || lines[0] !== "-----BEGIN GETDONE DEVELOPMENT NODE CERTIFICATE-----"
    || lines[3] !== "-----END GETDONE DEVELOPMENT NODE CERTIFICATE-----"
  ) {
    return null;
  }
  return { encoded: lines[1], signature: lines[2] };
}

export class DevelopmentNodeIdentityIssuer implements NodeIdentityIssuer {
  private readonly secret: Buffer;

  constructor(secret: string | Buffer) {
    this.secret = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(secret);
    if (this.secret.length < 32) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Development Node identity signing secret must be at least 32 bytes"
      );
    }
  }

  async issue(request: NodeIdentityIssueRequest): Promise<NodeIdentityCredential> {
    if (Date.parse(request.expiresAt) <= Date.parse(request.issuedAt)) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Node identity credential expiry must follow issuance"
      );
    }
    const serialNumber = randomBytes(16).toString("hex");
    const payload: DevelopmentCredentialPayload = {
      nodeId: request.nodeId,
      portfolioId: request.portfolioId,
      companyId: request.companyId,
      serialNumber,
      publicKeyFingerprint: sha256Hex(request.publicKey),
      issuedAt: request.issuedAt,
      expiresAt: request.expiresAt,
      issuer: "getdone-development-node-ca"
    };
    const certificatePem = developmentCertificate(payload, this.secret);
    const base = {
      id: crypto.randomUUID(),
      nodeId: request.nodeId,
      serialNumber,
      publicKeyFingerprint: payload.publicKeyFingerprint,
      certificatePem,
      certificateChainPem: [
        "-----BEGIN GETDONE DEVELOPMENT NODE CA-----",
        "development-only-not-a-production-ca",
        "-----END GETDONE DEVELOPMENT NODE CA-----"
      ].join("\n"),
      issuedAt: request.issuedAt,
      expiresAt: request.expiresAt,
      version: 1
    };
    return Object.freeze({
      ...base,
      credentialHash: sha256Hex(base)
    });
  }

  rotate(
    _current: NodeIdentityCredential,
    request: NodeIdentityIssueRequest
  ) {
    return this.issue(request);
  }

  async revoke() {
    // Development issuer has no remote CA state. Persistent revocation is store-owned.
  }

  async verify(credential: NodeIdentityCredential) {
    const parsed = parseDevelopmentCertificate(credential.certificatePem);
    if (!parsed) return false;
    const expected = createHmac("sha256", this.secret)
      .update(parsed.encoded)
      .digest();
    const actual = Buffer.from(parsed.signature, "base64url");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;

    let payload: DevelopmentCredentialPayload;
    try {
      payload = JSON.parse(Buffer.from(parsed.encoded, "base64url").toString("utf8"));
    } catch {
      return false;
    }
    return (
      payload.nodeId === credential.nodeId
      && payload.serialNumber === credential.serialNumber
      && payload.publicKeyFingerprint === credential.publicKeyFingerprint
      && payload.issuedAt === credential.issuedAt
      && payload.expiresAt === credential.expiresAt
      && payload.issuer === "getdone-development-node-ca"
      && sha256Hex({
        id: credential.id,
        nodeId: credential.nodeId,
        serialNumber: credential.serialNumber,
        publicKeyFingerprint: credential.publicKeyFingerprint,
        certificatePem: credential.certificatePem,
        certificateChainPem: credential.certificateChainPem,
        issuedAt: credential.issuedAt,
        expiresAt: credential.expiresAt,
        version: credential.version
      }) === credential.credentialHash
    );
  }
}
