import { describe, expect, it } from "vitest";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import {
  assertVoiceIntentRecord,
  createVoiceIntentAuditEvent,
  createVoiceIntentRecord,
  createVoiceSummaryResponse,
  parseVoiceAdapterCandidate,
  VOICE_ADAPTER_CONTRACT_VERSION,
  VOICE_INTENT_CONTRACT_VERSION,
  type VoiceIntentRecord
} from "@/lib/voice/voice-intents";

const scope: TrustedExecutionScope = {
  userId: "user-1",
  portfolioId: "portfolio-1",
  companyId: "company-1",
  environment: "production"
};

const transcriptHash = "a".repeat(64);

function candidate(
  intent:
    | "whats-important"
    | "check-resources"
    | "resource-health"
    | "add-raspberry-pi"
    | "drain-resource"
    | "compute-usage"
    | "provider-explanation",
  slots: { resourceId?: string; providerId?: string } = {}
) {
  return {
    source: "voice-adapter" as const,
    adapterId: "development-voice",
    adapterVersion: VOICE_ADAPTER_CONTRACT_VERSION,
    transcriptHash,
    confidence: 0.98,
    intent,
    slots
  };
}

describe("Phase 42 voice intent and secure handoff", () => {
  it("routes supported read intents through the Control API and current policy registry", () => {
    const examples = [
      candidate("whats-important"),
      candidate("check-resources"),
      candidate("resource-health", { resourceId: "resource-dc-west" }),
      candidate("compute-usage"),
      candidate("provider-explanation", { providerId: "provider-x" })
    ];

    for (const [index, input] of examples.entries()) {
      const record = createVoiceIntentRecord({
        id: `voice-${index}`,
        correlationId: `correlation-${index}`,
        trustedScope: scope,
        candidate: input,
        createdAt: "2026-09-20T22:10:00Z"
      });

      expect(record.contractVersion).toBe(VOICE_INTENT_CONTRACT_VERSION);
      expect(record.disposition).toBe("query");
      expect(record.requiresPolicyEvaluation).toBe(true);
      expect(record.authority.usesControlApi).toBe(true);
      expect(record.authority.usesCurrentPolicyRegistry).toBe(true);
      expect(record.authority.canApprove).toBe(false);
      expect(record.authority.canExecuteSideEffect).toBe(false);
      expect(record.adapter.transcriptHash).toBe(transcriptHash);
      expect(JSON.stringify(record)).not.toContain("What's important");
      expect(assertVoiceIntentRecord(record)).toBe(record);
    }
  });

  it("hands Raspberry Pi enrollment to the secure phone setup flow", () => {
    const record = createVoiceIntentRecord({
      id: "voice-add-pi",
      correlationId: "correlation-add-pi",
      trustedScope: scope,
      candidate: candidate("add-raspberry-pi"),
      createdAt: "2026-09-20T22:10:00Z"
    });

    expect(record.controlApiOperation).toBe("resource.enrollment.initiate");
    expect(record.disposition).toBe("secure-handoff-required");
    expect(record.secureHandoffPath).toBe("/resources/add");
    expect(record.authority.canAcceptRawCredentials).toBe(false);
    expect(record.authority.canStepUp).toBe(false);
    expect(record.authority.canExecuteSideEffect).toBe(false);
    expect(record.authority.strongApprovalHandling).toBe("secure-phone-only");
    expect(record.authority.credentialHandling).toBe("secure-provider-or-phone-only");
  });

  it("allows voice to propose a drain workflow without granting approval or execution authority", () => {
    const record = createVoiceIntentRecord({
      id: "voice-drain",
      correlationId: "correlation-drain",
      trustedScope: scope,
      candidate: candidate("drain-resource", { resourceId: "home-gpu-1" }),
      createdAt: "2026-09-20T22:10:00Z"
    });

    expect(record.controlApiOperation).toBe("resource.drain.request");
    expect(record.disposition).toBe("workflow-initiation");
    expect(record.secureHandoffPath).toBe("/resources/home-gpu-1");
    expect(record.requiresFreshStepUpInVoice).toBe(false);
    expect(record.authority.canApprove).toBe(false);
    expect(record.authority.canStepUp).toBe(false);
    expect(record.authority.canExecuteSideEffect).toBe(false);
  });

  it("rejects raw secret/credential material at voice ingress", () => {
    expect(() => parseVoiceAdapterCandidate({
      ...candidate("check-resources"),
      apiKey: "sk-123456789012345678901234567890"
    })).toThrow();

    expect(() => parseVoiceAdapterCandidate({
      ...candidate("provider-explanation", { providerId: "provider-x" }),
      slots: {
        providerId: "provider-x",
        token: "Bearer abcdefghijklmnopqrstuvwxyz"
      }
    })).toThrow();
  });

  it("rejects untrusted resource-slot escalation", () => {
    expect(() => createVoiceIntentRecord({
      id: "voice-resource",
      correlationId: "correlation-resource",
      trustedScope: { ...scope, resourceId: "resource-allowed" },
      candidate: candidate("resource-health", { resourceId: "resource-other" }),
      createdAt: "2026-09-20T22:10:00Z"
    })).toThrow();
  });

  it("fails closed when the authority flags or intent hash are tampered", () => {
    const record = createVoiceIntentRecord({
      id: "voice-tamper",
      correlationId: "correlation-tamper",
      trustedScope: scope,
      candidate: candidate("check-resources"),
      createdAt: "2026-09-20T22:10:00Z"
    });

    const weakened = {
      ...record,
      authority: {
        ...record.authority,
        canApprove: true
      }
    };
    expect(() => assertVoiceIntentRecord(weakened as unknown as VoiceIntentRecord)).toThrow();

    const tampered = {
      ...record,
      controlApiOperation: "production.deploy"
    };
    expect(() => assertVoiceIntentRecord(tampered)).toThrow();
  });

  it("creates only brief redacted Control API summaries with no authorization authority", () => {
    const record = createVoiceIntentRecord({
      id: "voice-summary",
      correlationId: "correlation-summary",
      trustedScope: scope,
      candidate: candidate("whats-important"),
      createdAt: "2026-09-20T22:10:00Z"
    });

    const response = createVoiceSummaryResponse({
      record,
      summary: "One high-priority decision needs your attention.",
      generatedAt: "2026-09-20T22:10:05Z"
    });
    expect(response.source).toBe("control-api");
    expect(response.presentation).toBe("brief-redacted");
    expect(response.voiceIntentHash).toBe(record.intentHash);
    expect(response.canAuthorize).toBe(false);

    expect(() => createVoiceSummaryResponse({
      record,
      summary: "Bearer abcdefghijklmnopqrstuvwxyz",
      generatedAt: "2026-09-20T22:10:05Z"
    })).toThrow();
  });

  it("creates a scoped audit event without raw transcript or credential data", () => {
    const record = createVoiceIntentRecord({
      id: "voice-audit",
      correlationId: "correlation-audit",
      trustedScope: scope,
      candidate: candidate("provider-explanation", { providerId: "provider-x" }),
      createdAt: "2026-09-20T22:10:00Z"
    });

    const audit = createVoiceIntentAuditEvent(record);
    expect(audit.eventType).toBe("voice.intent.accepted");
    expect(audit.actor).toEqual({ type: "user", id: "user-1" });
    expect(audit.scope.companyId).toBe("company-1");
    expect(audit.metadata.policyVersion).toBe(record.policyRegistry.version);
    expect(audit.metadata.canApprove).toBe(false);
    expect(audit.metadata.canExecuteSideEffect).toBe(false);
    expect(JSON.stringify(audit)).not.toMatch(/api[_-]?key|password|Bearer /i);
  });
});
