import { ControlPlaneError } from "@/lib/control-plane/errors";
import { createCredentialUsageAudit, assertCredentialLease, type CredentialLease, type CredentialUsageAudit } from "@/lib/credentials/broker";
import { getTelemetry, OTEL_SEMANTIC } from "@/lib/observability/telemetry";
import { readBoundedJson } from "@/lib/execution/adapters/ordinary-integration-framework";
import type {
  AuthorizedBusinessActionRequest,
  BusinessActionCredentialMaterial,
  BusinessActionCredentialRequirement
} from "@/lib/execution/adapters/business-action";

export interface CredentialLeaseReader {
  get(id: string): Promise<CredentialLease | null>;
}

export interface CredentialUsageAuditWriter {
  append(record: CredentialUsageAudit): Promise<void>;
}

export interface CredentialDeliveryProvider {
  redeem(input: {
    deliveryRef: string;
    lease: CredentialLease;
    request: AuthorizedBusinessActionRequest;
    requiredScopes: readonly string[];
  }): Promise<{
    material: string;
    expiresAt: string;
    providerId: string;
    credentialVersion: number;
    grantedScopes: readonly string[];
  }>;
}

export interface BusinessActionCredentialBroker {
  resolve(input: {
    request: AuthorizedBusinessActionRequest;
    requirement: BusinessActionCredentialRequirement;
  }): Promise<BusinessActionCredentialMaterial>;
  release?(credential: BusinessActionCredentialMaterial): Promise<void>;
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

export class GovernedBusinessActionCredentialBroker implements BusinessActionCredentialBroker {
  constructor(
    private readonly leases: CredentialLeaseReader,
    private readonly audits: CredentialUsageAuditWriter,
    private readonly delivery: CredentialDeliveryProvider,
    private readonly now: () => Date = () => new Date()
  ) {}

  async resolve(input: {
    request: AuthorizedBusinessActionRequest;
    requirement: BusinessActionCredentialRequirement;
  }): Promise<BusinessActionCredentialMaterial> {
    const leaseId = input.request.credentialLeaseId?.trim();
    if (!leaseId) {
      throw new ControlPlaneError("FORBIDDEN", "Credential-bearing business action requires a credential lease reference");
    }
    const resourceId = input.request.scope.resourceId?.trim();
    if (!resourceId) {
      throw new ControlPlaneError("FORBIDDEN", "Credential-bearing business action requires trusted resource scope");
    }
    const lease = await this.leases.get(leaseId);
    if (!lease) throw new ControlPlaneError("FORBIDDEN", "Credential lease was not found");

    const now = this.now();
    assertCredentialLease(lease, {
      scope: input.request.scope,
      jobId: input.request.jobId,
      resourceId,
      capability: input.request.capability,
      now: now.getTime()
    });

    if (lease.providerId !== input.requirement.providerId) {
      throw new ControlPlaneError("FORBIDDEN", "Credential lease provider does not match adapter requirement");
    }
    const requiredScopes = uniqueSorted(input.requirement.requiredScopes);
    if (!requiredScopes.every((scope) => lease.grantedScopes.includes(scope))) {
      throw new ControlPlaneError("FORBIDDEN", "Credential lease does not grant the adapter's required scopes");
    }

    const delivered = await this.delivery.redeem({
      deliveryRef: lease.deliveryRef,
      lease,
      request: input.request,
      requiredScopes
    });
    const expiresAt = Date.parse(delivered.expiresAt);
    if (
      !delivered.material
      || !Number.isFinite(expiresAt)
      || expiresAt <= now.getTime()
      || expiresAt > Date.parse(lease.expiresAt)
      || delivered.providerId !== lease.providerId
      || !Number.isInteger(delivered.credentialVersion)
      || delivered.credentialVersion < (lease.issuedCredentialVersion ?? 1)
      || !requiredScopes.every((scope) => delivered.grantedScopes.includes(scope))
      || delivered.grantedScopes.some((scope) => !lease.grantedScopes.includes(scope))
    ) {
      throw new ControlPlaneError("FORBIDDEN", "Credential delivery returned invalid, expired, or over-broad material");
    }

    await this.audits.append(createCredentialUsageAudit({
      id: crypto.randomUUID(),
      leaseId: lease.id,
      leaseHash: lease.leaseHash,
      jobId: lease.jobId,
      resourceId: lease.resourceId,
      capability: lease.capability,
      providerId: lease.providerId,
      credentialVersion: delivered.credentialVersion,
      usedAt: now.toISOString(),
      action: "used"
    }));
    await getTelemetry().counter("getdone.credential.redeem.total", 1, {
      [OTEL_SEMANTIC.provider]: lease.providerId,
      [OTEL_SEMANTIC.capability]: lease.capability,
      [OTEL_SEMANTIC.credentialVersion]: delivered.credentialVersion,
      [OTEL_SEMANTIC.companyId]: lease.companyId,
      [OTEL_SEMANTIC.environment]: lease.environment
    });

    return Object.freeze({
      leaseId: lease.id,
      leaseHash: lease.leaseHash,
      providerId: lease.providerId,
      credentialVersion: delivered.credentialVersion,
      capability: lease.capability,
      grantedScopes: Object.freeze([...delivered.grantedScopes]),
      material: delivered.material,
      issuedAt: now.toISOString(),
      expiresAt: new Date(expiresAt).toISOString()
    });
  }
}

export interface HttpCredentialDeliveryProviderConfig {
  url: string;
  brokerToken: string;
  timeoutMs?: number;
}

export class HttpCredentialDeliveryProvider implements CredentialDeliveryProvider {
  private readonly url: URL;
  private readonly timeoutMs: number;

  constructor(private readonly config: HttpCredentialDeliveryProviderConfig) {
    this.url = new URL(config.url);
    if (this.url.protocol !== "https:" || this.url.username || this.url.password || this.url.hash) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Credential delivery URL must be credential-free HTTPS");
    }
    if (!config.brokerToken.trim()) {
      throw new ControlPlaneError("UNAVAILABLE", "Credential broker authentication is required");
    }
    this.timeoutMs = config.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Credential delivery timeout must be 100-60000ms");
    }
  }

  async redeem(input: {
    deliveryRef: string;
    lease: CredentialLease;
    request: AuthorizedBusinessActionRequest;
    requiredScopes: readonly string[];
  }) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.brokerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        deliveryRef: input.deliveryRef,
        leaseId: input.lease.id,
        leaseHash: input.lease.leaseHash,
        jobId: input.request.jobId,
        providerId: input.lease.providerId,
        capability: input.request.capability,
        portfolioId: input.lease.portfolioId,
        companyId: input.lease.companyId,
        requiredScopes: input.requiredScopes
      }),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      throw new ControlPlaneError("UNAVAILABLE", `Credential delivery failed with HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 64_000) {
      throw new ControlPlaneError("UNAVAILABLE", "Credential delivery response exceeds size limit");
    }
    const value = await readBoundedJson(response, 64_000) as {
      material?: unknown;
      expiresAt?: unknown;
      providerId?: unknown;
      credentialVersion?: unknown;
      grantedScopes?: unknown;
    };
    if (
      typeof value.material !== "string"
      || typeof value.expiresAt !== "string"
      || typeof value.providerId !== "string"
      || !Number.isInteger(value.credentialVersion)
      || (value.credentialVersion as number) < 1
      || !Array.isArray(value.grantedScopes)
      || value.grantedScopes.some((scope) => typeof scope !== "string")
    ) {
      throw new ControlPlaneError("UNAVAILABLE", "Credential delivery returned malformed material");
    }
    return {
      material: value.material,
      expiresAt: value.expiresAt,
      providerId: value.providerId,
      credentialVersion: value.credentialVersion as number,
      grantedScopes: value.grantedScopes as string[]
    };
  }
}

export function readCredentialDeliveryProviderFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const url = env.GETDONE_CREDENTIAL_DELIVERY_URL?.trim();
  const brokerToken = env.GETDONE_CREDENTIAL_BROKER_TOKEN?.trim();
  if (!url || !brokerToken) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "GETDONE_CREDENTIAL_DELIVERY_URL and GETDONE_CREDENTIAL_BROKER_TOKEN are required for brokered credentials"
    );
  }
  return new HttpCredentialDeliveryProvider({
    url,
    brokerToken,
    timeoutMs: env.GETDONE_CREDENTIAL_DELIVERY_TIMEOUT_MS
      ? Number(env.GETDONE_CREDENTIAL_DELIVERY_TIMEOUT_MS)
      : undefined
  });
}
