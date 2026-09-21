import { describe, expect, it } from "vitest";
import {
  createVerificationEvidence,
  createVerificationRequest,
  resolveVerificationRequest
} from "@/lib/verification/verification";
import {
  assertVerificationSourceBinding,
  assertVerificationTrustAttestation,
  createVerificationSourceBinding,
  createVerificationTrustAttestation
} from "@/lib/verification/source-trust";

const scope = {
  userId: "owner-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production" as const
};

function request() {
  return createVerificationRequest({
    id: "request-source-trust",
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    environment: scope.environment,
    subject: { type: "allocation", id: "allocation-a" },
    strategies: ["resource-start"],
    requiresIndependentEvidence: true,
    executionIndependenceKey: "dispatch-hash-a",
    maxEvidenceAgeSeconds: 120,
    requestedAt: "2026-09-20T22:00:00Z",
    expiresAt: "2026-09-20T22:05:00Z"
  });
}

function evidence(independenceKey = "probe-domain-a") {
  return createVerificationEvidence({
    id: "evidence-source-trust",
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    subject: { type: "allocation", id: "allocation-a" },
    strategy: "resource-start",
    result: "pass",
    sourceType: "system-probe",
    sourceId: "probe-a",
    independenceKey,
    observedAt: "2026-09-20T22:00:10Z",
    expiresAt: "2026-09-20T22:04:00Z",
    payloadHash: "payload-a",
    provenance: "probe:a"
  });
}

function binding(independenceDomain = "probe-domain-a") {
  return createVerificationSourceBinding({
    id: "binding-probe-a",
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    environment: scope.environment,
    sourceType: "system-probe",
    sourceId: "probe-a",
    allowedStrategies: ["resource-start"],
    independenceDomain,
    status: "active",
    validFrom: "2026-09-20T21:00:00Z",
    expiresAt: "2026-09-20T23:00:00Z"
  });
}

describe("verification source trust", () => {
  it("attests verified evidence only when the source is authoritatively bound", () => {
    const req = request();
    const ev = evidence();
    const receipt = resolveVerificationRequest(req, [ev], {
      receiptId: "receipt-source-trust",
      verifiedAt: "2026-09-20T22:00:20Z",
      receiptTtlSeconds: 120
    });

    const attestation = createVerificationTrustAttestation({
      id: "attestation-a",
      request: req,
      receipt,
      evidence: [ev],
      sourceBindings: [binding()],
      scope,
      attestedAt: "2026-09-20T22:00:21Z"
    });

    expect(attestation.independent).toBe(true);
    expect(attestation.sourceBindingHashes).toHaveLength(1);
    expect(attestation.attestationHash).toHaveLength(64);
  });

  it("rejects caller-selected independence keys that do not match the authoritative binding", () => {
    const req = request();
    const ev = evidence("attacker-invented-domain");
    const receipt = resolveVerificationRequest(req, [ev], {
      receiptId: "receipt-forged-domain",
      verifiedAt: "2026-09-20T22:00:20Z"
    });

    expect(() => createVerificationTrustAttestation({
      id: "attestation-forged",
      request: req,
      receipt,
      evidence: [ev],
      sourceBindings: [binding("probe-domain-a")],
      scope,
      attestedAt: "2026-09-20T22:00:21Z"
    })).toThrow(/authoritative source binding/i);
  });

  it("rejects an unregistered verifier source", () => {
    const req = request();
    const ev = evidence();
    const receipt = resolveVerificationRequest(req, [ev], {
      receiptId: "receipt-unregistered",
      verifiedAt: "2026-09-20T22:00:20Z"
    });

    expect(() => createVerificationTrustAttestation({
      id: "attestation-unregistered",
      request: req,
      receipt,
      evidence: [ev],
      sourceBindings: [],
      scope,
      attestedAt: "2026-09-20T22:00:21Z"
    })).toThrow(/no authoritative source binding/i);
  });
  it("rejects revoked, expired, and cross-scope verification source bindings", () => {
    const ev = evidence();
    const revoked = createVerificationSourceBinding({
      id: "binding-revoked",
      portfolioId: scope.portfolioId,
      companyId: scope.companyId,
      environment: scope.environment,
      sourceType: "system-probe",
      sourceId: "probe-a",
      allowedStrategies: ["resource-start"],
      independenceDomain: "probe-domain-a",
      status: "revoked",
      validFrom: "2026-09-20T21:00:00Z",
      expiresAt: "2026-09-20T23:00:00Z"
    });
    expect(() => assertVerificationSourceBinding(revoked, {
      scope,
      evidence: ev,
      now: Date.parse("2026-09-20T22:00:21Z")
    })).toThrow(/inactive, out of scope, or not authorized/i);

    const expired = createVerificationSourceBinding({
      id: "binding-expired",
      portfolioId: scope.portfolioId,
      companyId: scope.companyId,
      environment: scope.environment,
      sourceType: "system-probe",
      sourceId: "probe-a",
      allowedStrategies: ["resource-start"],
      independenceDomain: "probe-domain-a",
      status: "active",
      validFrom: "2026-09-20T21:00:00Z",
      expiresAt: "2026-09-20T22:00:20Z"
    });
    expect(() => assertVerificationSourceBinding(expired, {
      scope,
      evidence: ev,
      now: Date.parse("2026-09-20T22:00:21Z")
    })).toThrow(/inactive, out of scope, or not authorized/i);

    const foreign = createVerificationSourceBinding({
      id: "binding-foreign",
      portfolioId: scope.portfolioId,
      companyId: "company-b",
      environment: scope.environment,
      sourceType: "system-probe",
      sourceId: "probe-a",
      allowedStrategies: ["resource-start"],
      independenceDomain: "probe-domain-a",
      status: "active",
      validFrom: "2026-09-20T21:00:00Z"
    });
    expect(() => assertVerificationSourceBinding(foreign, {
      scope,
      evidence: ev,
      now: Date.parse("2026-09-20T22:00:21Z")
    })).toThrow(/inactive, out of scope, or not authorized/i);
  });

  it("rejects evidence that becomes stale before trust attestation", () => {
    const req = request();
    const ev = evidence();
    const receipt = resolveVerificationRequest(req, [ev], {
      receiptId: "receipt-stale-at-attestation",
      verifiedAt: "2026-09-20T22:00:20Z",
      receiptTtlSeconds: 300
    });

    expect(() => createVerificationTrustAttestation({
      id: "attestation-stale",
      request: req,
      receipt,
      evidence: [ev],
      sourceBindings: [binding()],
      scope,
      attestedAt: "2026-09-20T22:02:11Z"
    })).toThrow(/stale at trust-attestation time/i);
  });

  it("rejects expired or tampered trust attestations", () => {
    const req = request();
    const ev = evidence();
    const receipt = resolveVerificationRequest(req, [ev], {
      receiptId: "receipt-attestation-expiry",
      verifiedAt: "2026-09-20T22:00:20Z",
      receiptTtlSeconds: 300
    });
    const attestation = createVerificationTrustAttestation({
      id: "attestation-expiring",
      request: req,
      receipt,
      evidence: [ev],
      sourceBindings: [binding()],
      scope,
      attestedAt: "2026-09-20T22:00:21Z",
      ttlSeconds: 1
    });

    expect(() => assertVerificationTrustAttestation(attestation, {
      request: req,
      receipt,
      scope,
      now: Date.parse("2026-09-20T22:00:22Z")
    })).toThrow(/stale or outside authoritative lineage/i);

    expect(() => assertVerificationTrustAttestation({
      ...attestation,
      subjectId: "different-allocation"
    }, {
      request: req,
      receipt,
      scope,
      now: Date.parse("2026-09-20T22:00:21.500Z")
    })).toThrow(/integrity check failed/i);
  });

});
