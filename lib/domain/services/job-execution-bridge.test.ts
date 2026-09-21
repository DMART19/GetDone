import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import {
  createJobCompletionVerificationEvidence,
  createJobCompletionVerificationRequest,
  createJobVerifiedCompletionFact,
  createJobVerifiedStartFact
} from "@/lib/domain/services/job-execution-bridge";
import type {
  VerifiedPlacementCompletion,
  VerifiedRunningPlacement
} from "@/lib/resources/scheduler";

const scope = {
  userId: "owner",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "staging" as const
};

function runningPlacement(): VerifiedRunningPlacement {
  const base = {
    id: "running-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    environment: "staging" as const,
    jobId: "job-1",
    placementDecisionId: "placement-decision-1",
    placementDecisionHash: "placement-decision-hash",
    reservationId: "reservation-1",
    reservationHash: "reservation-hash",
    allocationId: "allocation-1",
    allocationHash: "allocation-hash",
    dispatchIntentId: "dispatch-1",
    dispatchHash: "dispatch-hash",
    providerOperationId: "provider-operation",
    startVerificationRequestId: "start-request",
    startVerificationReceiptId: "start-receipt",
    startVerificationReceiptHash: "start-receipt-hash",
    startVerificationTrustAttestationId: "start-trust",
    startVerificationTrustAttestationHash: "start-trust-hash",
    startedVerifiedAt: "2026-09-20T22:00:06Z",
    state: "running-verified" as const,
    jobStateMutationApplied: false as const
  };
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}

function completion(running = runningPlacement()): VerifiedPlacementCompletion {
  const base = {
    id: "completion-1",
    runningPlacementId: running.id,
    runningPlacementHash: running.recordHash,
    completionVerificationRequestId: "completion-request",
    completionVerificationReceiptId: "completion-receipt",
    completionVerificationReceiptHash: "completion-receipt-hash",
    completionVerificationTrustAttestationId: "completion-trust",
    completionVerificationTrustAttestationHash: "completion-trust-hash",
    verifiedAt: "2026-09-20T22:02:02Z",
    state: "completed-verified" as const,
    jobStateMutationApplied: false as const
  };
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}

describe("Phase 34 to JobService verification bridge", () => {
  it("creates short-lived start authority only from an intact verified running placement", () => {
    const fact = createJobVerifiedStartFact({
      id: "start-fact-1",
      runningPlacement: runningPlacement(),
      scope,
      issuedAt: "2026-09-20T22:00:07Z",
      expiresAt: "2026-09-20T22:05:00Z"
    });
    expect(fact.jobId).toBe("job-1");
    expect(fact.runningPlacementHash).toHaveLength(64);
    expect(fact.factHash).toHaveLength(64);
    expect("providerOperationId" in fact).toBe(false);
  });

  it("rejects provider accepted data masquerading as verified-start authority", () => {
    const providerAccepted = {
      source: "resource-adapter",
      dispatchIntentId: "dispatch-1",
      dispatchHash: "dispatch-hash",
      adapterId: "adapter",
      adapterVersion: "1.0.0",
      status: "accepted",
      providerOperationId: "provider-op",
      observedAt: "2026-09-20T22:00:04Z",
      resultHash: "provider-result"
    };
    expect(() => createJobVerifiedStartFact({
      id: "forged-start",
      runningPlacement: providerAccepted as never,
      scope,
      issuedAt: "2026-09-20T22:00:07Z",
      expiresAt: "2026-09-20T22:05:00Z"
    })).toThrow(/verified-running placement/i);
  });

  it("binds completion to the exact verified running placement", () => {
    const running = runningPlacement();
    const fact = createJobVerifiedCompletionFact({
      id: "completion-fact-1",
      runningPlacement: running,
      completion: completion(running),
      scope,
      bridgedAt: "2026-09-20T22:02:03Z"
    });
    expect(fact.runningPlacementHash).toBe(running.recordHash);

    const otherRunning = { ...running, id: "running-2" };
    const rehashedOther = {
      ...otherRunning,
      recordHash: sha256Hex(Object.fromEntries(
        Object.entries(otherRunning).filter(([key]) => key !== "recordHash")
      ))
    } as VerifiedRunningPlacement;

    expect(() => createJobVerifiedCompletionFact({
      id: "completion-fact-forged",
      runningPlacement: rehashedOther,
      completion: completion(running),
      scope,
      bridgedAt: "2026-09-20T22:02:03Z"
    })).toThrow(/verified completion lineage/i);
  });

  it("feeds completion into Job verification without declaring Job success", () => {
    const running = runningPlacement();
    const fact = createJobVerifiedCompletionFact({
      id: "completion-fact-1",
      runningPlacement: running,
      completion: completion(running),
      scope,
      bridgedAt: "2026-09-20T22:02:03Z"
    });
    const request = createJobCompletionVerificationRequest({
      id: "job-verification-request",
      fact,
      scope,
      requestedAt: "2026-09-20T22:02:04Z",
      expiresAt: "2026-09-20T22:05:00Z",
      maxEvidenceAgeSeconds: 120
    });
    const evidence = createJobCompletionVerificationEvidence({
      id: "job-completion-evidence",
      fact,
      request,
      scope,
      observedAt: "2026-09-20T22:02:05Z"
    });

    expect(request.subject).toEqual({ type: "job", id: "job-1" });
    expect(evidence.strategy).toBe("execution");
    expect(evidence.payloadHash).toBe(fact.factHash);
    expect(evidence.result).toBe("pass");
  });
});
