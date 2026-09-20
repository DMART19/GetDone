import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  createSecretReference,
  createCredentialBinding,
  createCredentialRequest,
  issueCredentialLease,
  revokeCredentialLease
} from "@/lib/credentials/broker";
import { currentPolicyRegistryReference } from "@/lib/domain/policy-registry";
import {
  createAllocationRecord,
  createCapacityLedger,
  releaseReservation,
  reserveCapacity
} from "@/lib/resources/reservations";
import {
  createCapacityEconomicSnapshot,
  evaluateCostCapacityGovernor
} from "@/lib/resources/cost-governor";
import {
  createPlacementCandidateSnapshot,
  createPlacementRequest,
  evaluatePlacementCandidates
} from "@/lib/resources/placement";
import type { ResourcePolicy } from "@/lib/resources/policy";
import {
  createCompletionVerificationRequest,
  createDispatchAdapterResult,
  createDispatchAdmissionReceipt,
  createDispatchIntent,
  createPlacementDecision,
  createPlacementMonitor,
  createSchedulerAuditEntry,
  createSchedulerCandidateSnapshot,
  createStartVerificationRequest,
  createVerifiedPlacementCompletion,
  createVerifiedRunningPlacement,
  rankEligibleCandidates,
  releaseVerifiedPlacement,
  reservationAuthorityFromDecision
} from "@/lib/resources/scheduler";
import {
  createVerificationEvidence,
  resolveVerificationRequest
} from "@/lib/verification/verification";
import {
  createVerificationSourceBinding,
  createVerificationTrustAttestation
} from "@/lib/verification/source-trust";

const now = Date.parse("2026-09-20T22:00:00Z");
const scope = {
  userId: "owner-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production" as const
};

const request = createPlacementRequest({
  id: "placement-34",
  source: "control-plane",
  jobAuthorized: true,
  scope,
  jobId: "job-34",
  jobAuthorizationHash: "job-auth-34",
  requiredCapabilities: ["compute.cpu"],
  compute: { cpuCores: 2, memoryMb: 2048, architecture: "amd64" },
  priority: "high",
  checkpointable: true,
  retryable: true,
  dataClass: "INTERNAL",
  allowedRegions: ["us-west"],
  preferredLocality: "sacramento",
  reliabilityTier: "STANDARD",
  fallbackRequired: false,
  maxJobCostCents: 200,
  idempotencyKey: "job-34:placement",
  createdAt: "2026-09-20T21:50:00Z",
  expiresAt: "2026-09-20T22:20:00Z"
});

const policy: ResourcePolicy = {
  id: "policy-34",
  allowedEnvironments: ["production"],
  allowedDataClasses: ["INTERNAL"],
  allowedLocationClasses: ["CLOUD", "COLO"],
  allowedRegions: ["us-west"],
  minimumReliabilityTier: "STANDARD",
  requireEncryptionAtRest: true,
  requireEncryptionInTransit: true,
  requireFallback: false,
  allowedInterruptionClasses: ["NON_INTERRUPTIBLE"]
};

function placementCandidate(resourceId: string, overrides: Record<string, unknown> = {}) {
  return createPlacementCandidateSnapshot({
    resourceId,
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environmentPermissions: ["production"],
    locationClass: "CLOUD",
    region: "us-west",
    reliabilityTier: "HIGH",
    encryptedAtRest: true,
    encryptedInTransit: true,
    fallbackAvailable: true,
    interruptionClass: "NON_INTERRUPTIBLE",
    workloadClass: "compute.worker",
    healthStatus: "healthy",
    healthObservedAt: "2026-09-20T21:59:30Z",
    validatedCapabilities: ["compute.cpu"],
    architecture: "amd64",
    profileExpiresAt: "2026-09-20T22:30:00Z",
    profileHash: `profile-${resourceId}`,
    availableCapacity: { cpuCores: 8, memoryMb: 16384 },
    capacityObservedAt: "2026-09-20T21:59:00Z",
    capacityExpiresAt: "2026-09-20T22:10:00Z",
    credentialAvailable: true,
    estimatedJobCostCents: 50,
    ...overrides
  } as Parameters<typeof createPlacementCandidateSnapshot>[0]);
}

const resourceA = placementCandidate("resource-a");
const resourceB = placementCandidate("resource-b", {
  reliabilityTier: "CRITICAL",
  estimatedJobCostCents: 80
});
const forbidden = placementCandidate("resource-forbidden", {
  locationClass: "HOME"
});

const placementReport = evaluatePlacementCandidates({
  request,
  candidates: [resourceA, resourceB, forbidden],
  policy,
  now
});

function economics(resourceId: string, placementSnapshotHash: string, hourlyCost: number) {
  return {
    resourceId,
    placementSnapshotHash,
    requestedDurationSeconds: 3600,
    economicSnapshot: createCapacityEconomicSnapshot({
      id: `econ-${resourceId}`,
      resourceId,
      portfolioId: "portfolio-a",
      companyId: "company-a",
      capacityClass: "variable-on-demand" as const,
      totalUnits: 16,
      usedUnits: 4,
      reservedUnits: 2,
      protectedHeadroomUnits: 2,
      requestedUnits: 2,
      quotaLimitUnits: 32,
      quotaUsedUnits: 4,
      effectiveHourlyCents: hourlyCost,
      marginalHourlyCents: Math.max(0, hourlyCost - 5),
      observedAt: "2026-09-20T21:59:00Z",
      expiresAt: "2026-09-20T22:10:00Z"
    })
  };
}

function governor(approvalAboveCents = 200) {
  return evaluateCostCapacityGovernor({
    placementReport,
    portfolioId: "portfolio-a",
    companyId: "company-a",
    jobId: "job-34",
    candidates: [
      economics("resource-a", resourceA.snapshotHash, 50),
      economics("resource-b", resourceB.snapshotHash, 80),
      economics("resource-forbidden", forbidden.snapshotHash, 1)
    ],
    budget: {
      id: "budget-34",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      jobId: "job-34",
      hardCapCents: 200,
      approvalAboveCents,
      status: "active"
    },
    now
  });
}

function schedulerSnapshot(
  resourceId: string,
  placementHash: string,
  overrides: Record<string, unknown> = {}
) {
  return createSchedulerCandidateSnapshot({
    resourceId,
    placementCandidateSnapshotHash: placementHash,
    reliabilityTier: "HIGH",
    locality: "sacramento",
    estimatedCostCents: 50,
    startupLatencyMs: 500,
    protectedCapacityImpactPct: 10,
    observedAt: "2026-09-20T21:59:00Z",
    expiresAt: "2026-09-20T22:05:00Z",
    ...overrides
  } as Parameters<typeof createSchedulerCandidateSnapshot>[0]);
}

function ranking(governorReport = governor()) {
  return rankEligibleCandidates({
    placementReport,
    governorReport,
    candidates: [
      schedulerSnapshot("resource-a", resourceA.snapshotHash),
      schedulerSnapshot("resource-b", resourceB.snapshotHash, {
        reliabilityTier: "CRITICAL",
        locality: "reno",
        estimatedCostCents: 80,
        startupLatencyMs: 300,
        protectedCapacityImpactPct: 5
      })
    ],
    preferences: {
      weights: {
        reliability: 2,
        locality: 2,
        cost: 1,
        startupLatency: 1,
        protectedCapacityImpact: 1,
        ownerPreference: 2
      },
      preferredLocality: "sacramento",
      ownerPreferredResourceIds: ["resource-a", "resource-b"]
    },
    evaluatedAt: "2026-09-20T22:00:00Z"
  });
}

function decision(governorReport = governor()) {
  return createPlacementDecision({
    id: "decision-34",
    request,
    placementReport,
    rankingReport: ranking(governorReport),
    decidedAt: "2026-09-20T22:00:00Z"
  });
}

function reserved(decisionRecord = decision()) {
  const ledger = createCapacityLedger({
    id: "ledger-a",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    target: { type: "resource", id: decisionRecord.selectedResourceId },
    totalCapacity: { cpu: 8, memoryMb: 16384 },
    protectedHeadroom: { cpu: 2, memoryMb: 2048 },
    updatedAt: "2026-09-20T22:00:00Z"
  });
  const reservation = reserveCapacity({
    transactionId: "txn-reserve-34",
    reservationId: "reservation-34",
    ledger,
    expectedLedgerRevision: ledger.revision,
    authority: reservationAuthorityFromDecision(decisionRecord),
    requestedCapacity: { cpu: 2, memoryMb: 2048 },
    idempotencyKey: "decision-34:reserve",
    issuedAt: "2026-09-20T22:00:01Z",
    expiresAt: "2026-09-20T22:10:00Z"
  });
  const allocation = createAllocationRecord({
    id: "allocation-34",
    reservation: reservation.reservation,
    jobId: "job-34",
    createdAt: "2026-09-20T22:00:02Z",
    now: Date.parse("2026-09-20T22:00:02Z")
  });
  return { ...reservation, allocation, decisionRecord };
}

function credentialLease(decisionRecord = decision()) {
  const providerId = "provider-cloud";
  const capability = "compute.run";
  const secret = createSecretReference({
    id: "secret-34",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    providerId,
    environment: "production",
    purpose: "resource dispatch",
    backendRef: "vault://provider-cloud/dispatch",
    status: "active",
    rotationVersion: 1
  });
  const binding = createCredentialBinding({
    id: "binding-34",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    providerId,
    environment: "production",
    secretReferenceId: secret.id,
    capabilityNames: [capability],
    grantedScopes: ["execute"],
    allowedResourceIds: [decisionRecord.selectedResourceId],
    allowedLocationClasses: ["cloud"],
    status: "active"
  });
  const credentialRequest = createCredentialRequest({
    id: "credential-request-34",
    jobId: decisionRecord.jobId,
    placementRequestId: decisionRecord.placementRequestId,
    scope: {
      ...scope,
      resourceId: decisionRecord.selectedResourceId
    },
    resourceId: decisionRecord.selectedResourceId,
    resourceState: "ready",
    resourceLocationClass: "cloud",
    providerId,
    capability,
    requestedScopes: ["execute"],
    requestedAt: "2026-09-20T21:59:00Z",
    expiresAt: "2026-09-20T22:10:00Z"
  });
  const lease = issueCredentialLease({
    leaseId: "credential-lease-34",
    request: credentialRequest,
    secret,
    binding,
    deliveryRef: "delivery://credential-lease-34",
    issuedAt: "2026-09-20T22:00:01Z",
    ttlSeconds: 600
  });
  return { lease, providerId, capability };
}

function dispatched(options: {
  killSwitches?: Parameters<typeof createDispatchAdmissionReceipt>[0]["killSwitches"];
  leaseOverride?: ReturnType<typeof credentialLease>["lease"];
} = {}) {
  const governorReport = governor();
  const decisionRecord = decision(governorReport);
  const base = reserved(decisionRecord);
  const credential = credentialLease(decisionRecord);
  const lease = options.leaseOverride ?? credential.lease;
  const admissionReceipt = createDispatchAdmissionReceipt({
    id: "dispatch-admission-34",
    decision: decisionRecord,
    reservation: base.reservation,
    allocation: base.allocation,
    credentialLease: lease,
    governorReport,
    policyRegistry: currentPolicyRegistryReference(),
    killSwitches: options.killSwitches ?? [],
    resourceState: "ready",
    environmentPermissions: ["production"],
    providerId: credential.providerId,
    capability: credential.capability,
    admittedAt: "2026-09-20T22:00:02Z"
  });
  const dispatch = createDispatchIntent({
    id: "dispatch-34",
    decision: decisionRecord,
    reservation: base.reservation,
    allocation: base.allocation,
    credentialLease: lease,
    admissionReceipt,
    adapterId: "adapter-cloud",
    adapterVersion: "1.0.0",
    providerId: credential.providerId,
    capability: credential.capability,
    idempotencyKey: "allocation-34:dispatch",
    issuedAt: "2026-09-20T22:00:03Z",
    now: Date.parse("2026-09-20T22:00:03Z")
  });
  const adapterResult = createDispatchAdapterResult({
    source: "resource-adapter",
    dispatchIntentId: dispatch.id,
    dispatchHash: dispatch.dispatchHash,
    adapterId: dispatch.adapterId,
    adapterVersion: dispatch.adapterVersion,
    status: "accepted",
    providerOperationId: "provider-op-34",
    executionRef: "provider-ref-34",
    observedAt: "2026-09-20T22:00:04Z"
  });
  return {
    ...base,
    governorReport,
    credential,
    lease,
    admissionReceipt,
    dispatch,
    adapterResult
  };
}

function sourceBinding(input: {
  id: string;
  sourceId: string;
  strategy: "resource-start" | "execution";
  independenceDomain: string;
}) {
  return createVerificationSourceBinding({
    id: input.id,
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "production",
    sourceType: "system-probe",
    sourceId: input.sourceId,
    allowedStrategies: [input.strategy],
    independenceDomain: input.independenceDomain,
    status: "active",
    validFrom: "2026-09-20T21:00:00Z",
    expiresAt: "2026-09-20T23:00:00Z"
  });
}

function startVerification(base = dispatched()) {
  const verificationRequest = createStartVerificationRequest({
    id: "verify-start-34",
    dispatch: base.dispatch,
    requestedAt: "2026-09-20T22:00:04Z",
    expiresAt: "2026-09-20T22:05:00Z",
    maxEvidenceAgeSeconds: 120
  });
  const evidence = createVerificationEvidence({
    id: "start-evidence-34",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    subject: verificationRequest.subject,
    strategy: "resource-start",
    result: "pass",
    sourceType: "system-probe",
    sourceId: "probe-34",
    independenceKey: "probe-independent-34",
    observedAt: "2026-09-20T22:00:05Z",
    payloadHash: sha256Hex({ process: "running", allocationId: "allocation-34" }),
    provenance: "phase34-test"
  });
  const verificationReceipt = resolveVerificationRequest(
    verificationRequest,
    [evidence],
    {
      receiptId: "start-receipt-34",
      verifiedAt: "2026-09-20T22:00:06Z",
      receiptTtlSeconds: 120
    }
  );
  const verificationTrustAttestation = createVerificationTrustAttestation({
    id: "start-trust-34",
    request: verificationRequest,
    receipt: verificationReceipt,
    evidence: [evidence],
    sourceBindings: [sourceBinding({
      id: "source-binding-start-34",
      sourceId: "probe-34",
      strategy: "resource-start",
      independenceDomain: "probe-independent-34"
    })],
    scope,
    attestedAt: "2026-09-20T22:00:06Z"
  });
  return {
    ...base,
    verificationRequest,
    verificationReceipt,
    verificationTrustAttestation
  };
}

function runningPlacement() {
  const base = startVerification();
  const running = createVerifiedRunningPlacement({
    id: "running-34",
    decision: base.decisionRecord,
    reservation: base.reservation,
    allocation: base.allocation,
    dispatch: base.dispatch,
    adapterResult: base.adapterResult,
    verificationRequest: base.verificationRequest,
    verificationReceipt: base.verificationReceipt,
    verificationTrustAttestation: base.verificationTrustAttestation,
    scope,
    now: Date.parse("2026-09-20T22:00:06Z")
  });
  return { ...base, running };
}

function verifiedCompletion(base = runningPlacement()) {
  const completionRequest = createCompletionVerificationRequest({
    id: "verify-completion-34",
    runningPlacement: base.running,
    requestedAt: "2026-09-20T22:02:00Z",
    expiresAt: "2026-09-20T22:05:00Z",
    maxEvidenceAgeSeconds: 120
  });
  const evidence = createVerificationEvidence({
    id: "completion-evidence-34",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    subject: completionRequest.subject,
    strategy: "execution",
    result: "pass",
    sourceType: "system-probe",
    sourceId: "completion-probe",
    independenceKey: "completion-independent",
    observedAt: "2026-09-20T22:02:01Z",
    payloadHash: sha256Hex({ exitCode: 0, allocationId: "allocation-34" }),
    provenance: "phase34-completion-test"
  });
  const receipt = resolveVerificationRequest(completionRequest, [evidence], {
    receiptId: "completion-receipt-34",
    verifiedAt: "2026-09-20T22:02:02Z",
    receiptTtlSeconds: 120
  });
  const trust = createVerificationTrustAttestation({
    id: "completion-trust-34",
    request: completionRequest,
    receipt,
    evidence: [evidence],
    sourceBindings: [sourceBinding({
      id: "source-binding-completion-34",
      sourceId: "completion-probe",
      strategy: "execution",
      independenceDomain: "completion-independent"
    })],
    scope,
    attestedAt: "2026-09-20T22:02:02Z"
  });
  const completion = createVerifiedPlacementCompletion({
    id: "completion-34",
    runningPlacement: base.running,
    verificationRequest: completionRequest,
    verificationReceipt: receipt,
    verificationTrustAttestation: trust,
    scope,
    now: Date.parse("2026-09-20T22:02:02Z")
  });
  return { ...base, completionRequest, completionReceipt: receipt, completionTrust: trust, completion };
}

describe("Phase 34 architecture-integrity scheduling and dispatch", () => {
  it("ranks only Phase 32 eligible candidates that Phase 35 autonomously allows", () => {
    const report = ranking();

    expect(report.rankedEligibleCandidates.map((item) => item.resourceId))
      .toEqual(["resource-a", "resource-b"]);
    expect(report.ignoredIneligibleCandidateIds).toEqual(["resource-forbidden"]);
    expect(report.governorReportHash).toBe(governor().reportHash);
  });

  it("removes approval-required Phase 35 candidates from autonomous scheduling", () => {
    const governed = governor(60);
    const report = ranking(governed);

    expect(report.rankedEligibleCandidates.map((item) => item.resourceId)).toEqual(["resource-a"]);
    expect(report.approvalRequiredCandidateIds).toEqual(["resource-b"]);
  });

  it("never permits a scheduler to select a Phase 32 or Phase 35 excluded candidate", () => {
    const report = ranking(governor(60));

    expect(() => createPlacementDecision({
      id: "decision-forbidden",
      request,
      placementReport,
      rankingReport: report,
      selectedResourceId: "resource-b",
      decidedAt: "2026-09-20T22:00:00Z"
    })).toThrow(/only a ranked placement-eligible candidate/i);

    expect(() => createPlacementDecision({
      id: "decision-policy-forbidden",
      request,
      placementReport,
      rankingReport: report,
      selectedResourceId: "resource-forbidden",
      decidedAt: "2026-09-20T22:00:00Z"
    })).toThrow();
  });

  it("creates a new auditable decision for retry/fallback without changing governor lineage", () => {
    const governed = governor();
    const first = decision(governed);
    const retry = createPlacementDecision({
      id: "decision-34-retry",
      request,
      placementReport,
      rankingReport: ranking(governed),
      selectedResourceId: "resource-b",
      decidedAt: "2026-09-20T22:00:10Z",
      retryOf: first,
      retryReason: "verified-start-failed"
    });

    expect(retry.retryOfDecisionHash).toBe(first.decisionHash);
    expect(retry.governorReportHash).toBe(first.governorReportHash);
  });

  it("binds final dispatch admission to Phase 33 reservation, Phase 35 governor, and Phase 29 credential", () => {
    const base = dispatched();

    expect(base.admissionReceipt.governorReportHash).toBe(base.governorReport.reportHash);
    expect(base.admissionReceipt.credentialLeaseHash).toBe(base.lease.leaseHash);
    expect(base.dispatch.dispatchAdmissionReceiptHash).toBe(base.admissionReceipt.receiptHash);
    expect(base.dispatch.credentialLeaseHash).toBe(base.lease.leaseHash);
  });

  it("blocks final dispatch admission when a current kill switch applies", () => {
    expect(() => dispatched({
      killSwitches: [{
        id: "resource-kill",
        scopeType: "resource",
        scopeId: "resource-a",
        enabled: true,
        reason: "incident",
        activatedAt: "2026-09-20T21:59:59Z",
        activatedBy: "control-plane"
      }]
    })).toThrow(/kill switches block dispatch admission/i);
  });

  it("blocks dispatch when the Phase 29 credential lease is revoked", () => {
    const governed = governor();
    const decisionRecord = decision(governed);
    const base = reserved(decisionRecord);
    const credential = credentialLease(decisionRecord);
    const revoked = revokeCredentialLease(credential.lease, "2026-09-20T22:00:02Z");

    expect(() => createDispatchAdmissionReceipt({
      id: "dispatch-admission-revoked",
      decision: decisionRecord,
      reservation: base.reservation,
      allocation: base.allocation,
      credentialLease: revoked,
      governorReport: governed,
      policyRegistry: currentPolicyRegistryReference(),
      killSwitches: [],
      resourceState: "ready",
      environmentPermissions: ["production"],
      providerId: credential.providerId,
      capability: credential.capability,
      admittedAt: "2026-09-20T22:00:03Z"
    })).toThrow(/credential lease/i);
  });

  it("blocks dispatch when the Phase 33 reservation is expired", () => {
    const governed = governor();
    const decisionRecord = decision(governed);
    const base = reserved(decisionRecord);
    const credential = credentialLease(decisionRecord);
    expect(() => createDispatchAdmissionReceipt({
      id: "dispatch-admission-expired-reservation",
      decision: decisionRecord,
      reservation: base.reservation,
      allocation: base.allocation,
      credentialLease: credential.lease,
      governorReport: governed,
      policyRegistry: currentPolicyRegistryReference(),
      killSwitches: [],
      resourceState: "ready",
      environmentPermissions: ["production"],
      providerId: credential.providerId,
      capability: credential.capability,
      admittedAt: "2026-09-20T22:10:00Z"
    })).toThrow(/cannot authorize dispatch/i);
  });

  it("does not treat provider accepted as trusted proof that work started", () => {
    const base = dispatched();
    const verificationRequest = createStartVerificationRequest({
      id: "verify-provider-only",
      dispatch: base.dispatch,
      requestedAt: "2026-09-20T22:00:04Z",
      expiresAt: "2026-09-20T22:05:00Z",
      maxEvidenceAgeSeconds: 120
    });
    const providerEvidence = createVerificationEvidence({
      id: "provider-self-evidence",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      subject: verificationRequest.subject,
      strategy: "resource-start",
      result: "pass",
      sourceType: "provider",
      sourceId: "adapter-cloud",
      independenceKey: base.dispatch.dispatchHash,
      observedAt: "2026-09-20T22:00:05Z",
      payloadHash: sha256Hex({ accepted: true }),
      provenance: "provider-ack"
    });
    const receipt = resolveVerificationRequest(verificationRequest, [providerEvidence], {
      receiptId: "provider-only-receipt",
      verifiedAt: "2026-09-20T22:00:06Z",
      receiptTtlSeconds: 120
    });

    expect(receipt.verdict).toBe("uncertain");
    expect(() => createVerificationTrustAttestation({
      id: "provider-only-trust",
      request: verificationRequest,
      receipt,
      evidence: [providerEvidence],
      sourceBindings: [],
      scope,
      attestedAt: "2026-09-20T22:00:06Z"
    })).toThrow();
  });

  it("rejects a passing receipt when verifier independence was caller-invented", () => {
    const base = dispatched();
    const verificationRequest = createStartVerificationRequest({
      id: "verify-forged-independent",
      dispatch: base.dispatch,
      requestedAt: "2026-09-20T22:00:04Z",
      expiresAt: "2026-09-20T22:05:00Z",
      maxEvidenceAgeSeconds: 120
    });
    const forgedEvidence = createVerificationEvidence({
      id: "forged-independent-evidence",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      subject: verificationRequest.subject,
      strategy: "resource-start",
      result: "pass",
      sourceType: "system-probe",
      sourceId: "probe-34",
      independenceKey: "invented-domain",
      observedAt: "2026-09-20T22:00:05Z",
      payloadHash: "forged-payload",
      provenance: "forged"
    });
    const receipt = resolveVerificationRequest(verificationRequest, [forgedEvidence], {
      receiptId: "forged-independent-receipt",
      verifiedAt: "2026-09-20T22:00:06Z"
    });
    expect(receipt.verdict).toBe("verified");

    expect(() => createVerificationTrustAttestation({
      id: "forged-independent-trust",
      request: verificationRequest,
      receipt,
      evidence: [forgedEvidence],
      sourceBindings: [sourceBinding({
        id: "authoritative-probe-binding",
        sourceId: "probe-34",
        strategy: "resource-start",
        independenceDomain: "probe-independent-34"
      })],
      scope,
      attestedAt: "2026-09-20T22:00:06Z"
    })).toThrow(/authoritative source binding/i);
  });

  it("requires fresh trusted independent resource-start verification before running", () => {
    const base = runningPlacement();

    expect(base.running.state).toBe("running-verified");
    expect(base.running.startVerificationTrustAttestationHash)
      .toBe(base.verificationTrustAttestation.attestationHash);
    expect(base.running.jobStateMutationApplied).toBe(false);
  });

  it("fails closed if trusted start verification arrives after reservation expiry", () => {
    const base = startVerification();
    expect(() => createVerifiedRunningPlacement({
      id: "running-too-late",
      decision: base.decisionRecord,
      reservation: base.reservation,
      allocation: base.allocation,
      dispatch: base.dispatch,
      adapterResult: base.adapterResult,
      verificationRequest: base.verificationRequest,
      verificationReceipt: base.verificationReceipt,
      verificationTrustAttestation: base.verificationTrustAttestation,
      scope,
      now: Date.parse("2026-09-20T22:10:00Z")
    })).toThrow(/cannot authorize dispatch/i);
  });

  it("creates monitoring and trusted completion without mutating Job truth", () => {
    const base = verifiedCompletion();
    const monitor = createPlacementMonitor({
      id: "monitor-34",
      runningPlacement: base.running,
      openedAt: "2026-09-20T22:00:07Z",
      expectedHeartbeatSeconds: 30
    });

    expect(monitor.state).toBe("monitoring");
    expect(base.completion.state).toBe("completed-verified");
    expect(base.completion.completionVerificationTrustAttestationHash)
      .toBe(base.completionTrust.attestationHash);
    expect(base.completion.jobStateMutationApplied).toBe(false);
  });

  it("releases verified completed capacity through the unchanged Phase 33 release contract", () => {
    const base = verifiedCompletion();
    const released = releaseVerifiedPlacement({
      transactionId: "txn-release-phase34",
      ledger: base.ledger,
      expectedLedgerRevision: base.ledger.revision,
      reservation: base.reservation,
      completion: base.completion,
      runningPlacement: base.running,
      releasedAt: "2026-09-20T22:02:03Z"
    });

    expect(released.reservation.state).toBe("released");
    expect(released.reservation.capacityHeld).toBe(false);
    expect(released.ledger.reservedCapacity).toEqual({ cpu: 0, memoryMb: 0 });
    expect(released.commit?.operation).toBe("release");
  });

  it("does not bypass exact-once Phase 33 release replay semantics", () => {
    const base = reserved();
    const first = releaseReservation({
      transactionId: "txn-direct-release",
      ledger: base.ledger,
      expectedLedgerRevision: base.ledger.revision,
      reservation: base.reservation,
      releasedAt: "2026-09-20T22:03:00Z"
    });
    const replay = releaseReservation({
      transactionId: "txn-direct-release-replay",
      ledger: first.ledger,
      expectedLedgerRevision: first.ledger.revision,
      reservation: first.reservation,
      releasedAt: "2026-09-20T22:03:01Z"
    });

    expect(replay.replayed).toBe(true);
    expect(replay.ledger.reservedCapacity).toEqual({ cpu: 0, memoryMb: 0 });
  });

  it("emits explainable hash-bound scheduler audit entries", () => {
    const d = decision();
    const audit = createSchedulerAuditEntry({
      id: "audit-decision-34",
      eventType: "placement.decision",
      portfolioId: d.portfolioId,
      companyId: d.companyId,
      jobId: d.jobId,
      occurredAt: d.decidedAt,
      explanation: d.rationale,
      relatedHashes: [
        d.placementReportHash,
        d.governorReportHash,
        d.rankingReportHash,
        d.decisionHash
      ]
    });

    expect(audit.explanation.length).toBeGreaterThan(1);
    expect(audit.relatedHashes).toContain(d.decisionHash);
    expect(audit.auditHash).toHaveLength(64);
  });
});
