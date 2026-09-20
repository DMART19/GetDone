import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { ResourceState } from "@/lib/domain/resources";

export type CredentialEnvironment = TrustedExecutionScope["environment"];
export type CredentialLocationClass = "home" | "office" | "cloud" | "colo" | "partner-dc";

export interface SecretReference {
  id: string;
  portfolioId: string;
  companyId: string;
  providerId: string;
  environment: CredentialEnvironment;
  purpose: string;
  backendRef: string;
  status: "active" | "rotating" | "revoked" | "unavailable";
  rotationVersion: number;
  rotatedAt?: string;
  expiresAt?: string;
}

export interface CredentialBinding {
  id: string;
  portfolioId: string;
  companyId: string;
  providerId: string;
  environment: CredentialEnvironment;
  secretReferenceId: string;
  capabilityNames: readonly string[];
  grantedScopes: readonly string[];
  allowedResourceIds?: readonly string[];
  allowedLocationClasses?: readonly CredentialLocationClass[];
  status: "active" | "revoked" | "expired" | "unavailable";
  expiresAt?: string;
}

export interface CredentialRequest {
  source: "control-plane";
  id: string;
  jobId: string;
  placementRequestId: string;
  scope: TrustedExecutionScope;
  resourceId: string;
  resourceState: ResourceState;
  resourceLocationClass: CredentialLocationClass;
  providerId: string;
  capability: string;
  requestedScopes: readonly string[];
  requestedAt: string;
  expiresAt: string;
}

export interface CredentialLease {
  id: string;
  requestId: string;
  requestHash: string;
  jobId: string;
  placementRequestId: string;
  portfolioId: string;
  companyId: string;
  environment: CredentialEnvironment;
  resourceId: string;
  providerId: string;
  capability: string;
  grantedScopes: readonly string[];
  bindingId: string;
  secretReferenceId: string;
  deliveryRef: string;
  issuedAt: string;
  expiresAt: string;
  status: "active" | "revoked" | "expired" | "released";
  revokedAt?: string;
  releasedAt?: string;
  leaseHash: string;
}

export interface CredentialUsageAudit {
  id: string;
  leaseId: string;
  leaseHash: string;
  jobId: string;
  resourceId: string;
  capability: string;
  providerId: string;
  usedAt: string;
  action: "issued" | "used" | "revoked" | "released";
  auditHash: string;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

function assertReferenceOnly(value: string, label: string) {
  if (!value || value.length > 512) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a non-empty reference`);
  }
  if (/\s/.test(value)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must not contain whitespace`);
  }
}

export function createSecretReference(input: SecretReference): SecretReference {
  assertReferenceOnly(input.backendRef, "Secret backend reference");
  if (!input.id || !input.portfolioId || !input.companyId || !input.providerId || !input.purpose) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Secret reference identity and scope are required");
  }
  if (!Number.isInteger(input.rotationVersion) || input.rotationVersion < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Secret rotation version must be positive");
  }
  if (input.expiresAt) parseTime(input.expiresAt, "Secret expiry");
  return Object.freeze({ ...input });
}

export function createCredentialBinding(input: CredentialBinding): CredentialBinding {
  if (
    !input.id
    || !input.secretReferenceId
    || !input.portfolioId
    || !input.companyId
    || !input.providerId
    || input.capabilityNames.length === 0
  ) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Credential binding identity and capabilities are required");
  }
  if (input.expiresAt) parseTime(input.expiresAt, "Credential binding expiry");
  return Object.freeze({
    ...input,
    capabilityNames: Object.freeze(uniqueSorted(input.capabilityNames)),
    grantedScopes: Object.freeze(uniqueSorted(input.grantedScopes)),
    allowedResourceIds: input.allowedResourceIds
      ? Object.freeze(uniqueSorted(input.allowedResourceIds))
      : undefined,
    allowedLocationClasses: input.allowedLocationClasses
      ? Object.freeze(uniqueSorted(input.allowedLocationClasses) as CredentialLocationClass[])
      : undefined
  });
}

export function createCredentialRequest(
  input: Omit<CredentialRequest, "source"> & { source?: "control-plane" }
): CredentialRequest {
  const requestedAt = parseTime(input.requestedAt, "Credential request time");
  const expiresAt = parseTime(input.expiresAt, "Credential request expiry");
  if (expiresAt <= requestedAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Credential request expiry must be after request time");
  }
  if (!input.scope.resourceId || input.scope.resourceId !== input.resourceId) {
    throw new ControlPlaneError("FORBIDDEN", "Credential request must be bound to trusted resource scope");
  }
  if (!input.id || !input.jobId || !input.placementRequestId || !input.capability || !input.providerId) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Credential request identity and capability are required");
  }
  return Object.freeze({
    ...input,
    source: "control-plane" as const,
    requestedScopes: Object.freeze(uniqueSorted(input.requestedScopes))
  });
}

export function issueCredentialLease(input: {
  leaseId: string;
  request: CredentialRequest;
  secret: SecretReference;
  binding: CredentialBinding;
  deliveryRef: string;
  issuedAt: string;
  ttlSeconds: number;
}): CredentialLease {
  const { request, secret, binding } = input;
  const issuedAt = parseTime(input.issuedAt, "Credential lease issue time");
  const requestExpiresAt = parseTime(request.expiresAt, "Credential request expiry");

  if (request.source !== "control-plane") {
    throw new ControlPlaneError("FORBIDDEN", "Only the control plane may request credentials");
  }
  if (issuedAt < parseTime(request.requestedAt, "Credential request time") || issuedAt >= requestExpiresAt) {
    throw new ControlPlaneError("FORBIDDEN", "Credential request is not active");
  }
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0 || input.ttlSeconds > 3600) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Credential lease TTL must be 1-3600 seconds");
  }
  if (request.resourceState !== "ready") {
    throw new ControlPlaneError("FORBIDDEN", "Credentials may only be issued to READY resources");
  }
  if (
    request.scope.portfolioId !== secret.portfolioId
    || request.scope.companyId !== secret.companyId
    || request.scope.environment !== secret.environment
    || request.providerId !== secret.providerId
    || secret.status !== "active"
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Secret reference is outside the credential request scope");
  }
  if (
    binding.portfolioId !== request.scope.portfolioId
    || binding.companyId !== request.scope.companyId
    || binding.environment !== request.scope.environment
    || binding.providerId !== request.providerId
    || binding.secretReferenceId !== secret.id
    || binding.status !== "active"
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Credential binding is inactive or outside trusted scope");
  }
  if (binding.expiresAt && parseTime(binding.expiresAt, "Credential binding expiry") <= issuedAt) {
    throw new ControlPlaneError("FORBIDDEN", "Credential binding is expired");
  }
  if (secret.expiresAt && parseTime(secret.expiresAt, "Secret expiry") <= issuedAt) {
    throw new ControlPlaneError("FORBIDDEN", "Secret reference is expired");
  }
  if (!binding.capabilityNames.includes(request.capability)) {
    throw new ControlPlaneError("FORBIDDEN", "Credential binding does not authorize the requested capability");
  }
  if (!request.requestedScopes.every((scope) => binding.grantedScopes.includes(scope))) {
    throw new ControlPlaneError("FORBIDDEN", "Credential request exceeds the binding scope");
  }
  if (binding.allowedResourceIds && !binding.allowedResourceIds.includes(request.resourceId)) {
    throw new ControlPlaneError("FORBIDDEN", "Resource is not allowed to use this credential binding");
  }
  if (
    binding.allowedLocationClasses
    && !binding.allowedLocationClasses.includes(request.resourceLocationClass)
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Resource location is not allowed to use this credential binding");
  }

  assertReferenceOnly(input.deliveryRef, "Credential delivery reference");
  const expiresAtMs = Math.min(issuedAt + input.ttlSeconds * 1000, requestExpiresAt);
  const requestHash = sha256Hex(request);
  const base: Omit<CredentialLease, "leaseHash"> = {
    id: input.leaseId,
    requestId: request.id,
    requestHash,
    jobId: request.jobId,
    placementRequestId: request.placementRequestId,
    portfolioId: request.scope.portfolioId,
    companyId: request.scope.companyId,
    environment: request.scope.environment,
    resourceId: request.resourceId,
    providerId: request.providerId,
    capability: request.capability,
    grantedScopes: Object.freeze([...request.requestedScopes]),
    bindingId: binding.id,
    secretReferenceId: secret.id,
    deliveryRef: input.deliveryRef,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    status: "active"
  };
  return Object.freeze({ ...base, leaseHash: sha256Hex(base) });
}

export function assertCredentialLease(
  lease: CredentialLease,
  input: {
    scope: TrustedExecutionScope;
    jobId: string;
    resourceId: string;
    capability: string;
    now?: number;
  }
) {
  const { leaseHash, ...base } = lease;
  if (sha256Hex(base) !== leaseHash) {
    throw new ControlPlaneError("FORBIDDEN", "Credential lease integrity check failed");
  }
  const now = input.now ?? Date.now();
  if (
    lease.status !== "active"
    || Date.parse(lease.issuedAt) > now
    || Date.parse(lease.expiresAt) <= now
    || lease.portfolioId !== input.scope.portfolioId
    || lease.companyId !== input.scope.companyId
    || lease.environment !== input.scope.environment
    || lease.resourceId !== input.resourceId
    || lease.resourceId !== input.scope.resourceId
    || lease.jobId !== input.jobId
    || lease.capability !== input.capability
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Credential lease is expired, inactive, or out of scope");
  }
  return lease;
}

function transitionLease(
  lease: CredentialLease,
  status: "revoked" | "released",
  at: string
): CredentialLease {
  const now = parseTime(at, "Credential lease transition time");
  assertCredentialLease(lease, {
    scope: {
      userId: "credential-broker",
      portfolioId: lease.portfolioId,
      companyId: lease.companyId,
      environment: lease.environment,
      resourceId: lease.resourceId
    },
    jobId: lease.jobId,
    resourceId: lease.resourceId,
    capability: lease.capability,
    now
  });
  const current: Omit<CredentialLease, "leaseHash"> = {
    id: lease.id,
    requestId: lease.requestId,
    requestHash: lease.requestHash,
    jobId: lease.jobId,
    placementRequestId: lease.placementRequestId,
    portfolioId: lease.portfolioId,
    companyId: lease.companyId,
    environment: lease.environment,
    resourceId: lease.resourceId,
    providerId: lease.providerId,
    capability: lease.capability,
    grantedScopes: lease.grantedScopes,
    bindingId: lease.bindingId,
    secretReferenceId: lease.secretReferenceId,
    deliveryRef: lease.deliveryRef,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    status: lease.status,
    revokedAt: lease.revokedAt,
    releasedAt: lease.releasedAt
  };
  const base: Omit<CredentialLease, "leaseHash"> = {
    ...current,
    status,
    ...(status === "revoked" ? { revokedAt: new Date(now).toISOString() } : {}),
    ...(status === "released" ? { releasedAt: new Date(now).toISOString() } : {})
  };
  return Object.freeze({ ...base, leaseHash: sha256Hex(base) });
}

export function revokeCredentialLease(lease: CredentialLease, revokedAt: string) {
  return transitionLease(lease, "revoked", revokedAt);
}

export function releaseCredentialLease(lease: CredentialLease, releasedAt: string) {
  return transitionLease(lease, "released", releasedAt);
}

export function createCredentialUsageAudit(input: Omit<CredentialUsageAudit, "auditHash">) {
  const base: Omit<CredentialUsageAudit, "auditHash"> = {
    ...input,
    usedAt: new Date(parseTime(input.usedAt, "Credential audit time")).toISOString()
  };
  return Object.freeze({ ...base, auditHash: sha256Hex(base) });
}
