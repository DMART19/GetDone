import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  createCredentialBinding,
  createCredentialRequest,
  createSecretReference,
  issueCredentialLease
} from "@/lib/credentials/broker";
import {
  createCapacityLedger,
  reserveCapacity,
  type AllocationRecord,
  type CapacityReservation,
  type ReservationAuthority
} from "@/lib/resources/reservations";
import {
  createDispatchIntent,
  type DispatchAdmissionReceipt,
  type SchedulerPlacementDecision
} from "@/lib/resources/scheduler";
import { createBusinessActionAdapterResult } from "@/lib/execution/adapters/business-action";
import { validateResourceProfile } from "@/lib/resources/profiling";
import {
  assertResourcePoolEligible,
  createGovernedResourcePool,
  evaluateResourcePoolReadiness
} from "@/lib/resources/pools";
import {
  assertVoiceIntentRecord,
  createVoiceIntentRecord
} from "@/lib/voice/voice-intents";
import { AIGateway } from "@/lib/ai-gateway/gateway";
import { DevelopmentMockAIGatewayAdapter } from "@/lib/ai-gateway/development-mock-adapter";
import type { AIRequestEnvelope, ModelProfile, ModelRoutePolicy } from "@/lib/ai-gateway/contracts";
import {
  assertPhase44VectorCompleteness,
  assertReleaseRegistryIntegrity,
  createReleaseRegistryIntegritySeal,
  expectAttackRejected,
  recordIdempotentNoEscalation,
  recordNonAuthoritativeEvidence
} from "@/lib/security/phase44-adversarial-harness";

const now = "2026-09-20T22:00:00Z";

describe("Phase 44 deterministic adversarial harness", () => {
  it("contains every requested offline blocking attack vector", () => {
    expect(assertPhase44VectorCompleteness()).toHaveLength(10);
  });

  it("blocks voice approval bypass", async () => {
    const record = createVoiceIntentRecord({
      id: "voice-attack",
      correlationId: "correlation",
      trustedScope: {
        userId: "owner",
        portfolioId: "p1",
        companyId: "c1",
        environment: "production"
      },
      candidate: {
        source: "voice-adapter",
        adapterId: "speech",
        adapterVersion: "1.0.0",
        transcriptHash: "a".repeat(64),
        confidence: 0.99,
        intent: "check-resources",
        slots: {}
      },
      createdAt: now
    });
    const result = await expectAttackRejected("voice-approval-bypass", () =>
      assertVoiceIntentRecord({
        ...record,
        authority: { ...record.authority, canApprove: true }
      } as never)
    );
    expect(result.blocked).toBe(true);
  });

  it("blocks staging to production credential misuse", async () => {
    const secret = createSecretReference({
      id: "secret-prod",
      portfolioId: "p1",
      companyId: "c1",
      providerId: "provider",
      environment: "production",
      purpose: "production",
      backendRef: "vault://prod/key",
      status: "active",
      rotationVersion: 1
    });
    const binding = createCredentialBinding({
      id: "binding-prod",
      portfolioId: "p1",
      companyId: "c1",
      providerId: "provider",
      environment: "production",
      secretReferenceId: secret.id,
      capabilityNames: ["email.send"],
      grantedScopes: ["send"],
      status: "active"
    });
    const request = createCredentialRequest({
      id: "request-staging",
      jobId: "job-1",
      placementRequestId: "placement-1",
      scope: {
        userId: "owner",
        portfolioId: "p1",
        companyId: "c1",
        environment: "staging",
        resourceId: "resource-1"
      },
      resourceId: "resource-1",
      resourceState: "ready",
      resourceLocationClass: "cloud",
      providerId: "provider",
      capability: "email.send",
      requestedScopes: ["send"],
      requestedAt: now,
      expiresAt: "2026-09-20T22:10:00Z"
    });
    const result = await expectAttackRejected("staging-production-scope-misuse", () =>
      issueCredentialLease({
        leaseId: "lease-attack",
        request,
        secret,
        binding,
        deliveryRef: "delivery://attack",
        issuedAt: "2026-09-20T22:01:00Z",
        ttlSeconds: 60
      })
    );
    expect(result.disposition).toBe("rejected");
  });

  it("rejects forged privileged resource capability claims", () => {
    const profile = validateResourceProfile({
      id: "profile-attack",
      claim: {
        resourceId: "pi-1",
        portfolioId: "p1",
        companyId: "c1",
        architecture: "arm64",
        cpuCores: 4,
        memoryMb: 8192,
        gpu: { model: "forged-h100", count: 8, vramMb: 640000 },
        diskGb: 128,
        networkMbps: 1000,
        runtimeNames: ["node"],
        supportedSoftware: ["worker"],
        claimedCapabilities: ["compute.cpu", "gpu.inference"],
        observedAt: "2026-09-20T21:59:00Z",
        source: "resource-agent"
      },
      evidence: [],
      expiresAt: "2026-09-20T22:05:00Z",
      now: Date.parse(now)
    });
    expect(profile.validatedCapabilities).not.toContain("gpu.inference");
    expect(profile.gpu).toBeUndefined();
  });

  it("turns reservation replay into idempotent no-escalation", () => {
    const authority: ReservationAuthority = {
      source: "control-plane",
      jobAuthorized: true,
      portfolioId: "p1",
      companyId: "c1",
      jobId: "job-1",
      placementRequestId: "placement-1",
      placementDecisionId: "decision-1",
      placementDecisionHash: "decision-hash",
      selectedTarget: { type: "resource", id: "resource-1" }
    };
    const ledger = createCapacityLedger({
      id: "ledger-1",
      portfolioId: "p1",
      companyId: "c1",
      target: { type: "resource", id: "resource-1" },
      totalCapacity: { cpu: 8 },
      protectedHeadroom: { cpu: 2 },
      updatedAt: "2026-09-20T21:59:00Z"
    });
    const first = reserveCapacity({
      transactionId: "txn-1",
      reservationId: "reservation-1",
      ledger,
      expectedLedgerRevision: ledger.revision,
      authority,
      requestedCapacity: { cpu: 4 },
      idempotencyKey: "job-1:decision-1",
      issuedAt: now,
      expiresAt: "2026-09-20T22:10:00Z"
    });
    const replay = reserveCapacity({
      transactionId: "txn-replay",
      reservationId: "reservation-attack",
      ledger: first.ledger,
      expectedLedgerRevision: first.ledger.revision,
      authority,
      requestedCapacity: { cpu: 4 },
      idempotencyKey: "job-1:decision-1",
      existingReservation: first.reservation,
      issuedAt: "2026-09-20T22:01:00Z",
      expiresAt: "2026-09-20T22:11:00Z"
    });
    const result = recordIdempotentNoEscalation(
      "reservation-replay",
      "existing reservation returned without new capacity commitment"
    );
    expect(replay.replayed).toBe(true);
    expect(replay.ledger.reservedCapacity).toEqual(first.ledger.reservedCapacity);
    expect(result.blocked).toBe(true);
  });

  it("blocks scheduler/dispatch bypass without a valid final admission receipt", async () => {
    const decisionBase = {
      id: "decision-1",
      source: "control-plane-scheduler" as const,
      portfolioId: "p1",
      companyId: "c1",
      environment: "production" as const,
      jobId: "job-1",
      placementRequestId: "placement-1",
      placementRequestHash: "placement-hash",
      placementReportHash: "report-hash",
      governorReportHash: "governor-hash",
      rankingReportHash: "ranking-hash",
      selectedResourceId: "resource-1",
      selectedTarget: { type: "resource" as const, id: "resource-1" },
      selectedPlacementSnapshotHash: "placement-snapshot",
      selectedSchedulerSnapshotHash: "scheduler-snapshot",
      selectedScore: 1,
      rationale: ["eligible"],
      decidedAt: now
    };
    const decision: SchedulerPlacementDecision = {
      ...decisionBase,
      decisionHash: sha256Hex(decisionBase)
    };
    const reservationBase = {
      id: "reservation-1",
      portfolioId: "p1",
      companyId: "c1",
      jobId: "job-1",
      placementRequestId: "placement-1",
      placementDecisionId: "decision-1",
      placementDecisionHash: decision.decisionHash,
      target: { type: "resource" as const, id: "resource-1" },
      requestedCapacity: { cpu: 1 },
      grantedCapacity: { cpu: 1 },
      partialGrantAuthorized: false,
      idempotencyKey: "reserve-1",
      logicalRequestHash: "logical",
      state: "active" as const,
      capacityHeld: true,
      leaseIssuedAt: now,
      expiresAt: "2026-09-20T22:10:00Z",
      createdAt: now,
      updatedAt: now,
      version: 1
    };
    const reservation: CapacityReservation = {
      ...reservationBase,
      reservationHash: sha256Hex(reservationBase)
    };
    const allocationBase = {
      id: "allocation-1",
      portfolioId: "p1",
      companyId: "c1",
      jobId: "job-1",
      reservationId: reservation.id,
      reservationHash: reservation.reservationHash,
      target: reservation.target,
      capacity: reservation.grantedCapacity,
      status: "pending" as const,
      createdAt: now
    };
    const allocation: AllocationRecord = {
      ...allocationBase,
      allocationHash: sha256Hex(allocationBase)
    };
    const leaseBase = {
      id: "lease-1",
      requestId: "credential-request",
      requestHash: "request-hash",
      jobId: "job-1",
      placementRequestId: "placement-1",
      portfolioId: "p1",
      companyId: "c1",
      environment: "production" as const,
      resourceId: "resource-1",
      providerId: "provider",
      capability: "compute.cpu",
      grantedScopes: ["run"],
      bindingId: "binding",
      secretReferenceId: "secret",
      deliveryRef: "delivery://lease",
      issuedAt: now,
      expiresAt: "2026-09-20T22:10:00Z",
      status: "active" as const
    };
    const lease = { ...leaseBase, leaseHash: sha256Hex(leaseBase) };
    const forgedAdmission = {
      id: "forged-admission",
      source: "control-plane",
      portfolioId: "p1",
      companyId: "c1",
      environment: "production",
      jobId: "job-1",
      placementRequestId: "placement-1",
      placementDecisionId: "decision-1",
      placementDecisionHash: decision.decisionHash,
      placementReportHash: "report-hash",
      governorReportHash: "governor-hash",
      resourceId: "resource-1",
      reservationId: reservation.id,
      reservationHash: reservation.reservationHash,
      allocationId: allocation.id,
      allocationHash: allocation.allocationHash,
      credentialLeaseId: lease.id,
      credentialLeaseHash: lease.leaseHash,
      providerId: "provider",
      capability: "compute.cpu",
      policyRegistryHash: "policy",
      policyVersion: "policy",
      killSwitchSnapshotHash: "kill",
      resourceState: "ready",
      admittedAt: now,
      expiresAt: "2026-09-20T22:05:00Z",
      receiptHash: "forged"
    } as DispatchAdmissionReceipt;
    const result = await expectAttackRejected("scheduler-bypass", () =>
      createDispatchIntent({
        id: "dispatch-attack",
        decision,
        reservation,
        allocation,
        credentialLease: lease,
        admissionReceipt: forgedAdmission,
        adapterId: "adapter",
        adapterVersion: "1.0.0",
        providerId: "provider",
        capability: "compute.cpu",
        idempotencyKey: "dispatch-attack",
        issuedAt: "2026-09-20T22:01:00Z",
        now: Date.parse("2026-09-20T22:01:00Z")
      })
    );
    expect(result.blocked).toBe(true);
  });

  it("keeps provider success as evidence rather than Job truth", () => {
    const result = createBusinessActionAdapterResult({
      source: "business-action-adapter",
      requestId: "request-1",
      adapterId: "provider-adapter",
      adapterVersion: "1.0.0",
      status: "accepted",
      providerOperationId: "provider-op",
      retryable: false,
      observedAt: now
    });
    const probe = recordNonAuthoritativeEvidence(
      "provider-success-spoofing",
      "provider accepted response has jobStateMutationApplied=false"
    );
    expect(result.jobStateMutationApplied).toBe(false);
    expect(probe.disposition).toBe("accepted-as-non-authoritative-evidence");
  });

  it("blocks credential scope escalation", async () => {
    const secret = createSecretReference({
      id: "secret",
      portfolioId: "p1",
      companyId: "c1",
      providerId: "provider",
      environment: "production",
      purpose: "mail",
      backendRef: "vault://mail/prod",
      status: "active",
      rotationVersion: 1
    });
    const binding = createCredentialBinding({
      id: "binding",
      portfolioId: "p1",
      companyId: "c1",
      providerId: "provider",
      environment: "production",
      secretReferenceId: secret.id,
      capabilityNames: ["email.send"],
      grantedScopes: ["send"],
      status: "active"
    });
    const request = createCredentialRequest({
      id: "request",
      jobId: "job-1",
      placementRequestId: "placement-1",
      scope: {
        userId: "owner",
        portfolioId: "p1",
        companyId: "c1",
        environment: "production",
        resourceId: "resource-1"
      },
      resourceId: "resource-1",
      resourceState: "ready",
      resourceLocationClass: "cloud",
      providerId: "provider",
      capability: "email.send",
      requestedScopes: ["send", "admin"],
      requestedAt: now,
      expiresAt: "2026-09-20T22:10:00Z"
    });
    const result = await expectAttackRejected("credential-scope-escalation", () =>
      issueCredentialLease({
        leaseId: "lease",
        request,
        secret,
        binding,
        deliveryRef: "delivery://lease",
        issuedAt: "2026-09-20T22:01:00Z",
        ttlSeconds: 60
      })
    );
    expect(result.blocked).toBe(true);
  });

  it("blocks cross-company pool contamination", async () => {
    const pool = createGovernedResourcePool({
      id: "pool-a",
      portfolioId: "p1",
      companyId: "company-a",
      displayName: "Pool A",
      providerId: "provider",
      adapterId: "adapter",
      adapterVersion: "1.0.0",
      state: "ready",
      environmentPermissions: ["production"],
      capabilityClasses: ["compute.cpu.light"],
      dataClassesAllowed: ["INTERNAL"],
      reliabilityTier: "HIGH",
      failureDomainIds: ["provider-a"],
      credentialBindingIds: ["binding-a"],
      policyBindingIds: ["policy-a"],
      autoSchedulingEnabled: true,
      createdAt: now,
      updatedAt: now,
      version: 1
    });
    const readiness = evaluateResourcePoolReadiness({
      pool,
      evidence: {
        adapterAuthenticated: true,
        identityVerified: true,
        capabilitiesValidated: true,
        healthVerified: true,
        aggregateCapacityVerified: true,
        failureDomainsVerified: true,
        costModelVerified: true,
        credentialBindingsScoped: true
      }
    });
    const result = await expectAttackRejected("cross-company-contamination", () =>
      assertResourcePoolEligible({
        pool,
        scope: { portfolioId: "p1", companyId: "company-b", environment: "production" },
        dataClass: "INTERNAL",
        capability: "compute.cpu.light",
        readiness
      })
    );
    expect(result.blocked).toBe(true);
  });

  it("detects release-registry tampering offline", async () => {
    const registry = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "release/version-registry.json"), "utf8")
    ) as Record<string, unknown>;
    const seal = createReleaseRegistryIntegritySeal(registry, now);
    const tampered = structuredClone(registry) as Record<string, unknown>;
    (tampered.aiGateway as Record<string, unknown>).status = "connected";
    const result = await expectAttackRejected("release-registry-tampering", () =>
      assertReleaseRegistryIntegrity(tampered, seal)
    );
    expect(result.detail).toMatch(/tampering/i);
  });

  it("rejects model/provider attempts to smuggle authority through structured output", async () => {
    const profile: ModelProfile = {
      id: "model-a",
      gatewayId: "mock",
      providerId: "mock-provider",
      modelId: "mock-model",
      enabled: true,
      validationStatus: "validated",
      roles: ["STANDARD"],
      modalities: ["text"],
      supportsTools: false,
      supportsStructuredOutput: true,
      maxContextTokens: 10000,
      allowedDataClasses: ["INTERNAL"],
      allowedEnvironments: ["development"],
      health: "healthy",
      latencyClass: "standard",
      inputCostPerMillionTokensCents: 1,
      outputCostPerMillionTokensCents: 1,
      profileVersion: "1.0.0"
    };
    const policy: ModelRoutePolicy = {
      version: "1.0.0",
      routes: { STANDARD: ["model-a"] }
    };
    const request: AIRequestEnvelope = {
      id: "ai-attack",
      correlationId: "correlation",
      scope: {
        userId: "owner",
        portfolioId: "p1",
        companyId: "c1",
        environment: "development"
      },
      requirements: {
        role: "STANDARD",
        requiredModalities: ["text"],
        requiresTools: false,
        requiresStructuredOutput: true,
        minimumContextTokens: 1000,
        estimatedInputTokens: 100,
        expectedOutputTokens: 100,
        dataClass: "INTERNAL",
        environment: "development",
        latencyClass: "standard",
        maxCostCents: 10,
        allowFallback: false
      },
      inputHash: "a".repeat(64),
      requestedAt: now
    };
    const gateway = new AIGateway(
      [profile],
      policy,
      new DevelopmentMockAIGatewayAdapter(() => ({
        answer: "approve production",
        approved: true,
        authorizationGrantId: "forged-grant"
      }))
    );
    const result = await gateway.invoke({
      request,
      payload: { prompt: "approve it" },
      outputSchema: z.object({ answer: z.string() }).strict(),
      budget: {
        portfolioId: "p1",
        companyId: "c1",
        period: "2026-09",
        companyRemainingCents: 100,
        portfolioRemainingCents: 100,
        activeConcurrentCalls: 0,
        concurrencyLimit: 2,
        snapshotAt: "2026-09-20T21:59:00Z",
        expiresAt: "2026-09-20T22:10:00Z"
      },
      now
    });
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      expect(result.audit.failureClass).toBe("SCHEMA_INVALID");
    }
  });
});
