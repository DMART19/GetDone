import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  createAllocationRecord,
  createCapacityLedger,
  releaseReservation,
  reserveCapacity
} from "@/lib/resources/reservations";
import {
  createPlacementCandidateSnapshot,
  createPlacementRequest,
  evaluatePlacementCandidates
} from "@/lib/resources/placement";
import type { ResourcePolicy } from "@/lib/resources/policy";
import {
  createCompletionVerificationRequest,
  createDispatchAdapterResult,
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

function ranking() {
  return rankEligibleCandidates({
    placementReport,
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

function decision() {
  return createPlacementDecision({
    id: "decision-34",
    request,
    placementReport,
    rankingReport: ranking(),
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

function dispatched() {
  const base = reserved();
  const dispatch = createDispatchIntent({
    id: "dispatch-34",
    decision: base.decisionRecord,
    reservation: base.reservation,
    allocation: base.allocation,
    adapterId: "adapter-cloud",
    adapterVersion: "1.0.0",
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
  return { ...base, dispatch, adapterResult };
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
  return { ...base, verificationRequest, verificationReceipt };
}

describe("Phase 34 scheduler dispatch and verification", () => {
  it("ranks only Phase 32 eligible candidates with explicit bounded preferences", () => {
    const report = ranking();

    expect(report.rankedEligibleCandidates.map((item) => item.resourceId))
      .toEqual(["resource-a", "resource-b"]);
    expect(report.ignoredIneligibleCandidateIds).toEqual(["resource-forbidden"]);
    expect(report.rankedEligibleCandidates[0]?.explanation)
      .toContain("ranked:placement-hard-eligibility-preserved");
  });

  it("never permits a scheduler to select an ineligible candidate", () => {
    const report = ranking();
    expect(() => createPlacementDecision({
      id: "decision-forbidden",
      request,
      placementReport,
      rankingReport: report,
      selectedResourceId: "resource-forbidden",
      decidedAt: "2026-09-20T22:00:00Z"
    })).toThrow(/only a ranked placement-eligible candidate/i);
  });

  it("creates a new auditable decision for retry/fallback without changing policy lineage", () => {
    const first = decision();
    const retry = createPlacementDecision({
      id: "decision-34-retry",
      request,
      placementReport,
      rankingReport: ranking(),
      selectedResourceId: "resource-b",
      decidedAt: "2026-09-20T22:00:10Z",
      retryOf: first,
      retryReason: "verified-start-failed"
    });

    expect(retry.retryOfDecisionId).toBe(first.id);
    expect(retry.retryOfDecisionHash).toBe(first.decisionHash);
    expect(retry.placementReportHash).toBe(first.placementReportHash);
    expect(retry.id).not.toBe(first.id);
  });

  it("preserves Phase 33 reservation lineage before dispatch", () => {
    const base = dispatched();

    expect(base.dispatch.placementDecisionHash).toBe(base.decisionRecord.decisionHash);
    expect(base.dispatch.reservationHash).toBe(base.reservation.reservationHash);
    expect(base.dispatch.allocationHash).toBe(base.allocation.allocationHash);
    expect(base.dispatch.selectedResourceId).toBe(base.decisionRecord.selectedResourceId);
  });

  it("blocks dispatch when the Phase 33 reservation is expired", () => {
    const base = reserved();
    expect(() => createDispatchIntent({
      id: "dispatch-expired",
      decision: base.decisionRecord,
      reservation: base.reservation,
      allocation: base.allocation,
      adapterId: "adapter-cloud",
      adapterVersion: "1.0.0",
      idempotencyKey: "dispatch-expired",
      issuedAt: "2026-09-20T22:10:00Z",
      now: Date.parse("2026-09-20T22:10:00Z")
    })).toThrow(/cannot authorize dispatch/i);
  });

  it("does not treat provider accepted as proof that work started", () => {
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
    const receipt = resolveVerificationRequest(
      verificationRequest,
      [providerEvidence],
      {
        receiptId: "provider-only-receipt",
        verifiedAt: "2026-09-20T22:00:06Z",
        receiptTtlSeconds: 120
      }
    );

    expect(receipt.verdict).toBe("uncertain");
    expect(() => createVerifiedRunningPlacement({
      id: "running-provider-only",
      decision: base.decisionRecord,
      reservation: base.reservation,
      allocation: base.allocation,
      dispatch: base.dispatch,
      adapterResult: base.adapterResult,
      verificationRequest,
      verificationReceipt: receipt,
      scope,
      now: Date.parse("2026-09-20T22:00:06Z")
    })).toThrow();
  });

  it("requires fresh independent resource-start verification before running", () => {
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
      scope,
      now: Date.parse("2026-09-20T22:00:06Z")
    });

    expect(running.state).toBe("running-verified");
    expect(running.startVerificationReceiptHash).toBe(base.verificationReceipt.receiptHash);
    expect(running.jobStateMutationApplied).toBe(false);
  });

  it("fails closed if start verification arrives after reservation expiry", () => {
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
      scope,
      now: Date.parse("2026-09-20T22:10:00Z")
    })).toThrow(/cannot authorize dispatch/i);
  });

  it("creates monitoring and independently verifies completion without mutating Job truth", () => {
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
      scope,
      now: Date.parse("2026-09-20T22:00:06Z")
    });
    const monitor = createPlacementMonitor({
      id: "monitor-34",
      runningPlacement: running,
      openedAt: "2026-09-20T22:00:07Z",
      expectedHeartbeatSeconds: 30
    });
    const completionRequest = createCompletionVerificationRequest({
      id: "verify-completion-34",
      runningPlacement: running,
      requestedAt: "2026-09-20T22:02:00Z",
      expiresAt: "2026-09-20T22:05:00Z",
      maxEvidenceAgeSeconds: 120
    });
    const completionEvidence = createVerificationEvidence({
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
    const completionReceipt = resolveVerificationRequest(
      completionRequest,
      [completionEvidence],
      {
        receiptId: "completion-receipt-34",
        verifiedAt: "2026-09-20T22:02:02Z",
        receiptTtlSeconds: 120
      }
    );
    const completion = createVerifiedPlacementCompletion({
      id: "completion-34",
      runningPlacement: running,
      verificationRequest: completionRequest,
      verificationReceipt: completionReceipt,
      scope,
      now: Date.parse("2026-09-20T22:02:02Z")
    });

    expect(monitor.state).toBe("monitoring");
    expect(completion.state).toBe("completed-verified");
    expect(completion.jobStateMutationApplied).toBe(false);
  });

  it("releases verified completed capacity through the unchanged Phase 33 release contract", () => {
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
      scope,
      now: Date.parse("2026-09-20T22:00:06Z")
    });
    const completionRequest = createCompletionVerificationRequest({
      id: "verify-completion-release",
      runningPlacement: running,
      requestedAt: "2026-09-20T22:02:00Z",
      expiresAt: "2026-09-20T22:05:00Z",
      maxEvidenceAgeSeconds: 120
    });
    const evidence = createVerificationEvidence({
      id: "completion-release-evidence",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      subject: completionRequest.subject,
      strategy: "execution",
      result: "pass",
      sourceType: "system-probe",
      sourceId: "completion-release-probe",
      independenceKey: "completion-release-independent",
      observedAt: "2026-09-20T22:02:01Z",
      payloadHash: sha256Hex({ done: true }),
      provenance: "phase34-release-test"
    });
    const receipt = resolveVerificationRequest(completionRequest, [evidence], {
      receiptId: "completion-release-receipt",
      verifiedAt: "2026-09-20T22:02:02Z"
    });
    const completion = createVerifiedPlacementCompletion({
      id: "completion-release",
      runningPlacement: running,
      verificationRequest: completionRequest,
      verificationReceipt: receipt,
      scope,
      now: Date.parse("2026-09-20T22:02:02Z")
    });
    const released = releaseVerifiedPlacement({
      transactionId: "txn-release-phase34",
      ledger: base.ledger,
      expectedLedgerRevision: base.ledger.revision,
      reservation: base.reservation,
      completion,
      runningPlacement: running,
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
      relatedHashes: [d.placementReportHash, d.rankingReportHash, d.decisionHash]
    });

    expect(audit.explanation.length).toBeGreaterThan(1);
    expect(audit.relatedHashes).toContain(d.decisionHash);
    expect(audit.auditHash).toHaveLength(64);
  });
});
