import { describe, expect, it } from "vitest";
import {
  assertVerificationReceipt,
  createVerificationEvidence,
  createVerificationReceipt,
  createVerificationRequest
} from "@/lib/verification/verification";

const scope = {
  userId: "user-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "staging" as const
};

const issuedAt = "2026-09-20T19:30:00Z";
const now = Date.parse(issuedAt);

function request() {
  return createVerificationRequest({
    id: "verification-1",
    scope,
    targetType: "job",
    targetId: "job-1",
    strategies: ["execution", "system"],
    minEvidenceCount: 2,
    requireIndependentEvidence: true,
    maxEvidenceAgeSeconds: 300,
    requestedAt: "2026-09-20T19:25:00Z",
    expiresAt: "2026-09-20T20:00:00Z"
  });
}

function evidence(sourceAuthority: "execution" | "verifier", id: string) {
  return createVerificationEvidence({
    id,
    requestId: "verification-1",
    scope,
    targetType: "job",
    targetId: "job-1",
    strategy: sourceAuthority === "execution" ? "execution" : "system",
    sourceId: sourceAuthority === "execution" ? "worker-1" : "health-checker-1",
    sourceAuthority,
    observedAt: "2026-09-20T19:29:00Z",
    expiresAt: "2026-09-20T19:45:00Z",
    payloadHash: `payload-${id}`
  });
}

describe("verification receipts", () => {
  it("requires independent evidence for a verified result", () => {
    expect(() => createVerificationReceipt({
      id: "receipt-1",
      request: request(),
      evidence: [evidence("execution", "e1"), evidence("execution", "e2")],
      result: "verified",
      reason: "worker-only evidence",
      issuedAt,
      expiresAt: "2026-09-20T19:50:00Z"
    })).toThrow();
  });

  it("creates a hash-bound verified receipt from fresh independent evidence", () => {
    const receipt = createVerificationReceipt({
      id: "receipt-1",
      request: request(),
      evidence: [evidence("execution", "e1"), evidence("verifier", "e2")],
      result: "verified",
      reason: "execution and system health independently confirm success",
      issuedAt,
      expiresAt: "2026-09-20T19:50:00Z"
    });

    expect(receipt.independentSourceIds).toEqual(["health-checker-1"]);
    expect(assertVerificationReceipt(receipt, {
      scope,
      targetType: "job",
      targetId: "job-1",
      expectedResult: "verified",
      now
    }).receiptHash).toBe(receipt.receiptHash);
  });

  it("rejects stale evidence", () => {
    const stale = createVerificationEvidence({
      id: "stale",
      requestId: "verification-1",
      scope,
      targetType: "job",
      targetId: "job-1",
      strategy: "system",
      sourceId: "verifier",
      sourceAuthority: "verifier",
      observedAt: "2026-09-20T18:00:00Z",
      payloadHash: "stale-payload"
    });

    expect(() => createVerificationReceipt({
      id: "receipt-stale",
      request: request(),
      evidence: [evidence("execution", "e1"), stale],
      result: "verified",
      reason: "stale",
      issuedAt,
      expiresAt: "2026-09-20T19:50:00Z"
    })).toThrow();
  });

  it("allows an explicit uncertain receipt without inventing success", () => {
    const receipt = createVerificationReceipt({
      id: "receipt-uncertain",
      request: request(),
      evidence: [evidence("execution", "e1")],
      result: "uncertain",
      reason: "independent verifier unavailable",
      issuedAt,
      expiresAt: "2026-09-20T19:50:00Z"
    });

    expect(receipt.result).toBe("uncertain");
  });
});
