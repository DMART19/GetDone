import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export const INTEGRATION_CONFIGURATION_CONTRACT_VERSION = "1.0.0";

export type ManagedIntegrationKind =
  | "calendar"
  | "github"
  | "analytics"
  | "crm"
  | "gmail"
  | "slack"
  | "webhook"
  | "rest-api";

export type IntegrationConfigurationState =
  | "configured"
  | "connected"
  | "disabled"
  | "revoked";

export type IntegrationHealth =
  | "unverified"
  | "healthy"
  | "degraded"
  | "unavailable"
  | "disabled"
  | "revoked";

export interface IntegrationProviderDefinition {
  id: string;
  kind: ManagedIntegrationKind;
  displayName: string;
  adapterId: string;
  adapterVersion: string;
  capabilities: readonly string[];
  requiredScopes: Readonly<Record<string, readonly string[]>>;
}

export interface ManagedIntegrationConfiguration {
  id: string;
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  providerId: string;
  kind: ManagedIntegrationKind;
  displayName: string;
  adapterId: string;
  adapterVersion: string;
  credentialBindingId?: string;
  capabilityNames: readonly string[];
  requestedScopes: readonly string[];
  grantedScopes: readonly string[];
  state: IntegrationConfigurationState;
  health: IntegrationHealth;
  lastVerifiedAt?: string;
  lastVerificationEvidenceHash?: string;
  disabledAt?: string;
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
  recordHash: string;
}

export interface IntegrationVerificationEvidence {
  source: "integration-verifier";
  integrationId: string;
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  providerId: string;
  adapterId: string;
  adapterVersion: string;
  verified: boolean;
  health: "healthy" | "degraded" | "unavailable";
  grantedScopes: readonly string[];
  observedAt: string;
  evidenceHash: string;
}

export interface IntegrationConfigurationCreateInput {
  id: string;
  providerId: string;
  displayName: string;
  credentialBindingId?: string;
  capabilityNames: readonly string[];
}

export interface IntegrationConfigurationUpdateInput {
  displayName?: string;
  credentialBindingId?: string | null;
  capabilityNames?: readonly string[];
}

export interface IntegrationConfigurationStore {
  get(id: string): Promise<ManagedIntegrationConfiguration | null>;
  listByScope(
    portfolioId: string,
    companyId: string,
    environment: TrustedExecutionScope["environment"]
  ): Promise<readonly ManagedIntegrationConfiguration[]>;
  create(
    record: ManagedIntegrationConfiguration,
    input: { idempotencyKey: string; requestHash: string }
  ): Promise<ManagedIntegrationConfiguration>;
  save(
    record: ManagedIntegrationConfiguration,
    input: { idempotencyKey: string; requestHash: string; expectedRecordHash: string }
  ): Promise<ManagedIntegrationConfiguration>;
  appendVerification(evidence: IntegrationVerificationEvidence): Promise<void>;
}

const PROVIDERS: readonly IntegrationProviderDefinition[] = Object.freeze([
  Object.freeze({
    id: "calendar",
    kind: "calendar",
    displayName: "Calendar",
    adapterId: "calendar-scheduling",
    adapterVersion: "1.0.0",
    capabilities: Object.freeze([
      "calendar.event.read",
      "calendar.event.create",
      "calendar.event.update",
      "calendar.event.cancel"
    ]),
    requiredScopes: Object.freeze({
      "calendar.event.read": Object.freeze(["calendar.read"]),
      "calendar.event.create": Object.freeze(["calendar.write", "calendar.read"]),
      "calendar.event.update": Object.freeze(["calendar.write", "calendar.read"]),
      "calendar.event.cancel": Object.freeze(["calendar.write", "calendar.read"])
    })
  }),
  Object.freeze({
    id: "github",
    kind: "github",
    displayName: "GitHub",
    adapterId: "github-standard-operation",
    adapterVersion: "1.0.0",
    capabilities: Object.freeze([
      "github.repository.read",
      "github.branch.create",
      "github.commit.create",
      "github.protected-branch.commit",
      "github.pull-request.write",
      "github.issue.write",
      "github.pull-request.merge"
    ]),
    requiredScopes: Object.freeze({
      "github.repository.read": Object.freeze(["github.read"]),
      "github.branch.create": Object.freeze(["github.write", "github.read"]),
      "github.commit.create": Object.freeze(["github.write", "github.read"]),
      "github.protected-branch.commit": Object.freeze(["github.write", "github.read"]),
      "github.pull-request.write": Object.freeze(["github.write", "github.read"]),
      "github.issue.write": Object.freeze(["github.write", "github.read"]),
      "github.pull-request.merge": Object.freeze(["github.write", "github.read"])
    })
  }),
  Object.freeze({
    id: "analytics",
    kind: "analytics",
    displayName: "Analytics",
    adapterId: "analytics-data-ingestion",
    adapterVersion: "1.0.0",
    capabilities: Object.freeze(["analytics.ingest.read"]),
    requiredScopes: Object.freeze({
      "analytics.ingest.read": Object.freeze(["analytics.read"])
    })
  }),
  Object.freeze({
    id: "crm",
    kind: "crm",
    displayName: "CRM",
    adapterId: "crm-business-action",
    adapterVersion: "1.0.0",
    capabilities: Object.freeze(["crm.record.read", "crm.record.write"]),
    requiredScopes: Object.freeze({
      "crm.record.read": Object.freeze(["crm.read"]),
      "crm.record.write": Object.freeze(["crm.write", "crm.read"])
    })
  }),
  Object.freeze({
    id: "gmail",
    kind: "gmail",
    displayName: "Gmail",
    adapterId: "gmail-business-action",
    adapterVersion: "1.0.0",
    capabilities: Object.freeze(["email.send"]),
    requiredScopes: Object.freeze({
      "email.send": Object.freeze(["gmail.send"])
    })
  }),
  Object.freeze({
    id: "slack",
    kind: "slack",
    displayName: "Slack",
    adapterId: "slack-business-action",
    adapterVersion: "1.0.0",
    capabilities: Object.freeze(["slack.message.send"]),
    requiredScopes: Object.freeze({
      "slack.message.send": Object.freeze(["chat:write"])
    })
  }),
  Object.freeze({
    id: "webhook",
    kind: "webhook",
    displayName: "Webhook",
    adapterId: "configured-webhook-action",
    adapterVersion: "1.0.0",
    capabilities: Object.freeze(["webhook.send"]),
    requiredScopes: Object.freeze({
      "webhook.send": Object.freeze(["webhook.send"])
    })
  }),
  Object.freeze({
    id: "rest-api",
    kind: "rest-api",
    displayName: "REST API",
    adapterId: "configured-http-action",
    adapterVersion: "1.0.0",
    capabilities: Object.freeze(["http.request"]),
    requiredScopes: Object.freeze({
      "http.request": Object.freeze(["http.request"])
    })
  })
]);

const providerMap = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

function safeText(value: string, label: string, max = 200) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must contain 1-${max} characters`);
  }
  return trimmed;
}

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return new Date(parsed).toISOString();
}

function uniqueSorted(values: readonly string[]) {
  return Object.freeze([...new Set(values)].sort());
}

function assertReferenceOnly(value: string | undefined, label: string) {
  if (!value) return;
  const trimmed = value.trim();
  if (
    !trimmed
    || trimmed.length > 200
    || /\s/.test(trimmed)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(trimmed)
    || /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i.test(trimmed)
    || /\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}\b/i.test(trimmed)
  ) {
    throw new ControlPlaneError("FORBIDDEN", `${label} must be a reference, never raw credential material`);
  }
}

export function assertNoRawCredentialPayload(value: unknown, path = "payload") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawCredentialPayload(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (
        key !== "credentialBindingId"
        && /(secret|token|password|api.?key|private.?key|credential.?material|access.?key)/i.test(key)
      ) {
        throw new ControlPlaneError("FORBIDDEN", `${path} contains forbidden raw credential field ${key}`);
      }
      assertNoRawCredentialPayload(child, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string") {
    if (
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
      || /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i.test(value)
      || /\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}\b/i.test(value)
    ) {
      throw new ControlPlaneError("FORBIDDEN", `${path} contains raw credential material`);
    }
  }
}

export function listIntegrationProviders() {
  return PROVIDERS;
}

export function getIntegrationProvider(providerId: string) {
  const provider = providerMap.get(providerId);
  if (!provider) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Integration provider is not supported");
  }
  return provider;
}

function requiredScopes(provider: IntegrationProviderDefinition, capabilities: readonly string[]) {
  const scopes = new Set<string>();
  for (const capability of capabilities) {
    if (!provider.capabilities.includes(capability)) {
      throw new ControlPlaneError(
        "POLICY_BLOCKED",
        `Capability ${capability} is not supported by provider ${provider.id}`
      );
    }
    for (const scope of provider.requiredScopes[capability] ?? []) scopes.add(scope);
  }
  return uniqueSorted([...scopes]);
}

function integrityBase(record: Omit<ManagedIntegrationConfiguration, "recordHash">) {
  return {
    ...record,
    capabilityNames: uniqueSorted(record.capabilityNames),
    requestedScopes: uniqueSorted(record.requestedScopes),
    grantedScopes: uniqueSorted(record.grantedScopes)
  };
}

export function createManagedIntegration(input: {
  id: string;
  scope: TrustedExecutionScope;
  config: IntegrationConfigurationCreateInput;
  createdAt: string;
}): ManagedIntegrationConfiguration {
  assertNoRawCredentialPayload(input.config);
  const provider = getIntegrationProvider(input.config.providerId);
  const capabilityNames = uniqueSorted(input.config.capabilityNames);
  if (capabilityNames.length === 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", "At least one integration capability is required");
  }
  assertReferenceOnly(input.config.credentialBindingId, "credentialBindingId");
  const requestedScopes = requiredScopes(provider, capabilityNames);
  const createdAt = parseTime(input.createdAt, "Integration createdAt");
  const base = integrityBase({
    id: safeText(input.id, "integration id", 160),
    portfolioId: input.scope.portfolioId,
    companyId: input.scope.companyId,
    environment: input.scope.environment,
    providerId: provider.id,
    kind: provider.kind,
    displayName: safeText(input.config.displayName, "displayName", 160),
    adapterId: provider.adapterId,
    adapterVersion: provider.adapterVersion,
    credentialBindingId: input.config.credentialBindingId
      ? safeText(input.config.credentialBindingId, "credentialBindingId", 200)
      : undefined,
    capabilityNames,
    requestedScopes,
    grantedScopes: Object.freeze([]),
    state: "configured",
    health: "unverified",
    createdAt,
    updatedAt: createdAt
  });
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}

export function assertManagedIntegrationIntegrity(record: ManagedIntegrationConfiguration) {
  const { recordHash, ...base } = record;
  if (sha256Hex(integrityBase(base)) !== recordHash) {
    throw new ControlPlaneError("FORBIDDEN", "Integration configuration integrity check failed");
  }
  return record;
}

export function assertManagedIntegrationScope(
  record: ManagedIntegrationConfiguration,
  scope: TrustedExecutionScope
) {
  assertManagedIntegrationIntegrity(record);
  if (
    record.portfolioId !== scope.portfolioId
    || record.companyId !== scope.companyId
    || record.environment !== scope.environment
  ) {
    throw new ControlPlaneError("NOT_FOUND", "Integration configuration was not found in this scope");
  }
  return record;
}

export function updateManagedIntegration(input: {
  record: ManagedIntegrationConfiguration;
  scope: TrustedExecutionScope;
  patch: IntegrationConfigurationUpdateInput;
  updatedAt: string;
}) {
  assertManagedIntegrationScope(input.record, input.scope);
  if (input.record.state === "revoked") {
    throw new ControlPlaneError("CONFLICT", "Revoked integrations cannot be reconfigured");
  }
  assertNoRawCredentialPayload(input.patch);
  const provider = getIntegrationProvider(input.record.providerId);
  const capabilityNames = input.patch.capabilityNames
    ? uniqueSorted(input.patch.capabilityNames)
    : input.record.capabilityNames;
  const requestedScopes = requiredScopes(provider, capabilityNames);
  const credentialBindingId = input.patch.credentialBindingId === null
    ? undefined
    : input.patch.credentialBindingId ?? input.record.credentialBindingId;
  assertReferenceOnly(credentialBindingId, "credentialBindingId");
  const base = integrityBase({
    ...input.record,
    displayName: input.patch.displayName
      ? safeText(input.patch.displayName, "displayName", 160)
      : input.record.displayName,
    credentialBindingId,
    capabilityNames,
    requestedScopes,
    grantedScopes: Object.freeze([]),
    state: "configured",
    health: "unverified",
    lastVerifiedAt: undefined,
    lastVerificationEvidenceHash: undefined,
    disabledAt: undefined,
    updatedAt: parseTime(input.updatedAt, "Integration updatedAt")
  });
  delete (base as Partial<ManagedIntegrationConfiguration>).recordHash;
  return Object.freeze({ ...base, recordHash: sha256Hex(base) }) as ManagedIntegrationConfiguration;
}

export function createIntegrationVerificationEvidence(input: Omit<IntegrationVerificationEvidence, "evidenceHash">) {
  const grantedScopes = uniqueSorted(input.grantedScopes);
  const base = {
    ...input,
    grantedScopes,
    observedAt: parseTime(input.observedAt, "Integration verification observedAt")
  };
  return Object.freeze({ ...base, evidenceHash: sha256Hex(base) });
}

export function applyIntegrationVerification(input: {
  record: ManagedIntegrationConfiguration;
  scope: TrustedExecutionScope;
  evidence: IntegrationVerificationEvidence;
}) {
  assertManagedIntegrationScope(input.record, input.scope);
  const { evidenceHash, ...evidenceBase } = input.evidence;
  if (sha256Hex({ ...evidenceBase, grantedScopes: uniqueSorted(input.evidence.grantedScopes) }) !== evidenceHash) {
    throw new ControlPlaneError("FORBIDDEN", "Integration verification evidence integrity check failed");
  }
  if (
    input.evidence.source !== "integration-verifier"
    || input.evidence.integrationId !== input.record.id
    || input.evidence.portfolioId !== input.record.portfolioId
    || input.evidence.companyId !== input.record.companyId
    || input.evidence.environment !== input.record.environment
    || input.evidence.providerId !== input.record.providerId
    || input.evidence.adapterId !== input.record.adapterId
    || input.evidence.adapterVersion !== input.record.adapterVersion
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Integration verification evidence lineage mismatch");
  }
  if (
    input.evidence.verified
    && !input.record.requestedScopes.every((scope) => input.evidence.grantedScopes.includes(scope))
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Verified integration does not grant every required scope");
  }
  const observedAt = parseTime(input.evidence.observedAt, "Integration verification observedAt");
  const base = integrityBase({
    ...input.record,
    grantedScopes: input.evidence.verified ? input.evidence.grantedScopes : Object.freeze([]),
    state: input.evidence.verified ? "connected" : "configured",
    health: input.evidence.health,
    lastVerifiedAt: observedAt,
    lastVerificationEvidenceHash: input.evidence.evidenceHash,
    updatedAt: observedAt
  });
  delete (base as Partial<ManagedIntegrationConfiguration>).recordHash;
  return Object.freeze({ ...base, recordHash: sha256Hex(base) }) as ManagedIntegrationConfiguration;
}

export function controlManagedIntegration(input: {
  record: ManagedIntegrationConfiguration;
  scope: TrustedExecutionScope;
  action: "disable" | "revoke";
  at: string;
}) {
  assertManagedIntegrationScope(input.record, input.scope);
  const at = parseTime(input.at, "Integration control time");
  const base = integrityBase({
    ...input.record,
    state: input.action === "revoke" ? "revoked" : "disabled",
    health: input.action === "revoke" ? "revoked" : "disabled",
    grantedScopes: Object.freeze([]),
    ...(input.action === "revoke" ? { revokedAt: at } : { disabledAt: at }),
    updatedAt: at
  });
  delete (base as Partial<ManagedIntegrationConfiguration>).recordHash;
  return Object.freeze({ ...base, recordHash: sha256Hex(base) }) as ManagedIntegrationConfiguration;
}
