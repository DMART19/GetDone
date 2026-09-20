import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import { createAuditEvent, type AuditEvent } from "@/lib/domain/audit";
import {
  assertPolicyRegistryReference,
  currentPolicyRegistryReference,
  type PolicyRegistryReference
} from "@/lib/domain/policy-registry";
import { buildMobileDeepLink } from "@/lib/mobile/deep-links";

export const VOICE_INTENT_CONTRACT_VERSION = "1.0.0";
export const VOICE_ADAPTER_CONTRACT_VERSION = "1.0.0";

export type VoiceIntentName =
  | "whats-important"
  | "check-resources"
  | "resource-health"
  | "add-raspberry-pi"
  | "drain-resource"
  | "compute-usage"
  | "provider-explanation";

export type VoiceIntentDisposition =
  | "query"
  | "workflow-initiation"
  | "secure-handoff-required";

export interface VoiceIntentSlots {
  resourceId?: string;
  providerId?: string;
}

export interface VoiceAdapterInput {
  audioReference: string;
  locale?: string;
  correlationId: string;
}

export interface VoiceAdapterCandidate {
  source: "voice-adapter";
  adapterId: string;
  adapterVersion: string;
  transcriptHash: string;
  confidence: number;
  intent: VoiceIntentName;
  slots: VoiceIntentSlots;
}

export interface VoiceIntentAdapter {
  readonly id: string;
  readonly version: string;
  classify(input: VoiceAdapterInput): Promise<VoiceAdapterCandidate>;
}

export interface VoiceSummaryResponse {
  source: "control-api";
  voiceIntentId: string;
  voiceIntentHash: string;
  presentation: "brief-redacted";
  summary: string;
  generatedAt: string;
  canAuthorize: false;
  responseHash: string;
}

export interface VoiceAuthorityBoundary {
  usesControlApi: true;
  usesCurrentPolicyRegistry: true;
  canApprove: false;
  canStepUp: false;
  canExecuteSideEffect: false;
  canAcceptRawCredentials: false;
  strongApprovalHandling: "secure-phone-only";
  credentialHandling: "secure-provider-or-phone-only";
}

export interface VoiceIntentRecord {
  id: string;
  source: "voice";
  contractVersion: typeof VOICE_INTENT_CONTRACT_VERSION;
  correlationId: string;
  scope: TrustedExecutionScope;
  adapter: Readonly<{
    id: string;
    version: string;
    transcriptHash: string;
    confidence: number;
  }>;
  intent: VoiceIntentName;
  slots: Readonly<VoiceIntentSlots>;
  controlApiOperation: string;
  disposition: VoiceIntentDisposition;
  requiresPolicyEvaluation: true;
  requiresFreshStepUpInVoice: false;
  secureHandoffPath?: string;
  secureHandoffReason?: string;
  policyRegistry: PolicyRegistryReference;
  authority: VoiceAuthorityBoundary;
  createdAt: string;
  intentHash: string;
}

const authorityBoundary: VoiceAuthorityBoundary = Object.freeze({
  usesControlApi: true,
  usesCurrentPolicyRegistry: true,
  canApprove: false,
  canStepUp: false,
  canExecuteSideEffect: false,
  canAcceptRawCredentials: false,
  strongApprovalHandling: "secure-phone-only",
  credentialHandling: "secure-provider-or-phone-only"
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      `${label} contains unsupported fields: ${unexpected.sort().join(",")}`
    );
  }
}

function safeId(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a safe identifier`);
  }
  return value;
}

function safeVersion(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._+-]{1,80}$/.test(value)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a safe version string`);
  }
  return value;
}

function assertNoCredentialMaterial(value: unknown, label = "voice input") {
  const secretValuePatterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i
  ];
  const forbiddenKey = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|authorization)/i;

  const visit = (current: unknown, path: string) => {
    if (typeof current === "string" && secretValuePatterns.some((pattern) => pattern.test(current))) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        `${label} contains raw credential-like material at ${path}`
      );
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (isRecord(current)) {
      for (const [key, child] of Object.entries(current)) {
        if (forbiddenKey.test(key)) {
          throw new ControlPlaneError(
            "FORBIDDEN",
            `${label} may not contain credential field ${path}.${key}`
          );
        }
        visit(child, `${path}.${key}`);
      }
    }
  };

  visit(value, "$");
}

function validateSlots(intent: VoiceIntentName, slots: unknown): VoiceIntentSlots {
  if (!isRecord(slots)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Voice intent slots must be an object");
  }
  assertExactKeys(slots, ["resourceId", "providerId"], "Voice intent slots");

  const parsed: VoiceIntentSlots = {};
  if (slots.resourceId !== undefined) parsed.resourceId = safeId(slots.resourceId, "resourceId");
  if (slots.providerId !== undefined) parsed.providerId = safeId(slots.providerId, "providerId");

  const requiresResource = intent === "resource-health" || intent === "drain-resource";
  const requiresProvider = intent === "provider-explanation";
  if (requiresResource && !parsed.resourceId) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${intent} requires resourceId`);
  }
  if (requiresProvider && !parsed.providerId) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${intent} requires providerId`);
  }
  if (!requiresResource && parsed.resourceId) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${intent} does not accept resourceId`);
  }
  if (!requiresProvider && parsed.providerId) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${intent} does not accept providerId`);
  }
  return parsed;
}

export function parseVoiceAdapterCandidate(value: unknown): VoiceAdapterCandidate {
  assertNoCredentialMaterial(value);
  if (!isRecord(value)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Voice adapter candidate must be an object");
  }
  assertExactKeys(
    value,
    ["source", "adapterId", "adapterVersion", "transcriptHash", "confidence", "intent", "slots"],
    "Voice adapter candidate"
  );

  if (value.source !== "voice-adapter") {
    throw new ControlPlaneError("VALIDATION_FAILED", "Voice adapter candidate source is invalid");
  }
  if (
    typeof value.transcriptHash !== "string"
    || !/^[a-f0-9]{64}$/i.test(value.transcriptHash)
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Voice adapter candidate requires a SHA-256 transcript hash"
    );
  }
  if (
    typeof value.confidence !== "number"
    || !Number.isFinite(value.confidence)
    || value.confidence < 0
    || value.confidence > 1
  ) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Voice confidence must be between 0 and 1");
  }

  const intents: readonly VoiceIntentName[] = [
    "whats-important",
    "check-resources",
    "resource-health",
    "add-raspberry-pi",
    "drain-resource",
    "compute-usage",
    "provider-explanation"
  ];
  if (typeof value.intent !== "string" || !intents.includes(value.intent as VoiceIntentName)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Voice intent is unsupported");
  }
  const intent = value.intent as VoiceIntentName;

  return Object.freeze({
    source: "voice-adapter" as const,
    adapterId: safeId(value.adapterId, "adapterId"),
    adapterVersion: safeVersion(value.adapterVersion, "adapterVersion"),
    transcriptHash: value.transcriptHash.toLowerCase(),
    confidence: value.confidence,
    intent,
    slots: Object.freeze(validateSlots(intent, value.slots))
  });
}

function route(intent: VoiceIntentName, slots: VoiceIntentSlots): Readonly<{
  controlApiOperation: string;
  disposition: VoiceIntentDisposition;
  secureHandoffPath?: string;
  secureHandoffReason?: string;
}> {
  switch (intent) {
    case "whats-important":
      return {
        controlApiOperation: "attention.summary.read",
        disposition: "query"
      };
    case "check-resources":
      return {
        controlApiOperation: "resources.summary.read",
        disposition: "query"
      };
    case "resource-health":
      return {
        controlApiOperation: "resource.health.read",
        disposition: "query"
      };
    case "compute-usage":
      return {
        controlApiOperation: "resources.compute-usage.read",
        disposition: "query"
      };
    case "provider-explanation":
      return {
        controlApiOperation: "resources.provider-explanation.read",
        disposition: "query"
      };
    case "add-raspberry-pi":
      return {
        controlApiOperation: "resource.enrollment.initiate",
        disposition: "secure-handoff-required",
        secureHandoffPath: buildMobileDeepLink({ kind: "resource-add" }),
        secureHandoffReason: "Resource enrollment and any credential handoff continue on the secure phone flow"
      };
    case "drain-resource":
      return {
        controlApiOperation: "resource.drain.request",
        disposition: "workflow-initiation",
        secureHandoffPath: buildMobileDeepLink({
          kind: "resource",
          resourceId: safeId(slots.resourceId, "resourceId")
        }),
        secureHandoffReason: "Voice may propose the drain workflow; policy/approval and execution continue through the Control API"
      };
  }
}

export function createVoiceIntentRecord(input: {
  id: string;
  correlationId: string;
  trustedScope: TrustedExecutionScope;
  candidate: unknown;
  createdAt: string;
}): VoiceIntentRecord {
  safeId(input.id, "voiceIntentId");
  safeId(input.correlationId, "correlationId");
  const candidate = parseVoiceAdapterCandidate(input.candidate);

  if (
    input.trustedScope.resourceId
    && candidate.slots.resourceId
    && input.trustedScope.resourceId !== candidate.slots.resourceId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Voice resource slot does not match trusted resource scope"
    );
  }

  const createdAt = Date.parse(input.createdAt);
  if (!Number.isFinite(createdAt)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Voice intent createdAt is invalid");
  }

  const policyRegistry = currentPolicyRegistryReference();
  assertPolicyRegistryReference(policyRegistry);
  const routing = route(candidate.intent, candidate.slots);

  const base = {
    id: input.id,
    source: "voice" as const,
    contractVersion: VOICE_INTENT_CONTRACT_VERSION,
    correlationId: input.correlationId,
    scope: { ...input.trustedScope },
    adapter: {
      id: candidate.adapterId,
      version: candidate.adapterVersion,
      transcriptHash: candidate.transcriptHash,
      confidence: candidate.confidence
    },
    intent: candidate.intent,
    slots: { ...candidate.slots },
    controlApiOperation: routing.controlApiOperation,
    disposition: routing.disposition,
    requiresPolicyEvaluation: true as const,
    requiresFreshStepUpInVoice: false as const,
    secureHandoffPath: routing.secureHandoffPath,
    secureHandoffReason: routing.secureHandoffReason,
    policyRegistry,
    authority: authorityBoundary,
    createdAt: input.createdAt
  };

  return Object.freeze({
    ...base,
    scope: Object.freeze(base.scope),
    adapter: Object.freeze(base.adapter),
    slots: Object.freeze(base.slots),
    policyRegistry: Object.freeze({ ...base.policyRegistry }),
    intentHash: sha256Hex(base)
  });
}

export function assertVoiceIntentRecord(record: VoiceIntentRecord) {
  assertPolicyRegistryReference(record.policyRegistry);
  if (
    record.source !== "voice"
    || record.contractVersion !== VOICE_INTENT_CONTRACT_VERSION
    || record.requiresPolicyEvaluation !== true
    || record.requiresFreshStepUpInVoice !== false
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Voice intent contract/version binding is invalid");
  }
  const { intentHash, ...base } = record;
  if (sha256Hex(base) !== intentHash) {
    throw new ControlPlaneError("FORBIDDEN", "Voice intent integrity check failed");
  }
  if (
    record.authority.canApprove
    || record.authority.canStepUp
    || record.authority.canExecuteSideEffect
    || record.authority.canAcceptRawCredentials
    || record.authority.strongApprovalHandling !== "secure-phone-only"
    || record.authority.credentialHandling !== "secure-provider-or-phone-only"
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Voice authority boundary was weakened");
  }
  if (!record.authority.usesControlApi || !record.authority.usesCurrentPolicyRegistry) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Voice must route through the Control API and current policy registry"
    );
  }
  if (
    (record.disposition === "workflow-initiation"
      || record.disposition === "secure-handoff-required")
    && !record.secureHandoffPath
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Voice mutation/initiation requires a secure phone handoff path"
    );
  }
  return record;
}

export function createVoiceSummaryResponse(input: {
  record: VoiceIntentRecord;
  summary: string;
  generatedAt: string;
}): VoiceSummaryResponse {
  assertVoiceIntentRecord(input.record);
  assertNoCredentialMaterial(input.summary, "voice summary");
  const summary = input.summary.trim();
  if (!summary || summary.length > 600) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Voice summary must contain 1-600 characters"
    );
  }
  if (!Number.isFinite(Date.parse(input.generatedAt))) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Voice summary generatedAt is invalid");
  }
  const base = {
    source: "control-api" as const,
    voiceIntentId: input.record.id,
    voiceIntentHash: input.record.intentHash,
    presentation: "brief-redacted" as const,
    summary,
    generatedAt: input.generatedAt,
    canAuthorize: false as const
  };
  return Object.freeze({
    ...base,
    responseHash: sha256Hex(base)
  });
}

export function createVoiceIntentAuditEvent(record: VoiceIntentRecord): AuditEvent {
  assertVoiceIntentRecord(record);
  return createAuditEvent({
    correlationId: record.correlationId,
    eventType: "voice.intent.accepted",
    actor: { type: "user", id: record.scope.userId },
    scope: {
      userId: record.scope.userId,
      portfolioId: record.scope.portfolioId,
      companyId: record.scope.companyId,
      resourceId: record.slots.resourceId ?? record.scope.resourceId
    },
    environment: record.scope.environment,
    entityType: "voice-intent",
    entityId: record.id,
    provenance: `voice:${record.adapter.id}@${record.adapter.version}`,
    metadata: {
      intent: record.intent,
      disposition: record.disposition,
      controlApiOperation: record.controlApiOperation,
      transcriptHash: record.adapter.transcriptHash,
      confidence: record.adapter.confidence,
      policyVersion: record.policyRegistry.version,
      canApprove: false,
      canExecuteSideEffect: false,
      secureHandoffRequired: Boolean(record.secureHandoffPath)
    }
  });
}
