import { describe, expect, it } from "vitest";
import { assessResourceFabricExternalClaim } from "@/lib/security/resource-fabric-threats";

const now = Date.parse("2026-09-20T21:00:00Z");
const scope = {
  portfolioId: "portfolio-a",
  companyId: "company-a",
  resourceId: "resource-a"
};

function claim(
  kind: "resource-identity" | "enrollment-ready" | "heartbeat" | "capacity" | "reservation" | "placement"
) {
  return {
    kind,
    source: "resource-agent" as const,
    portfolioId: "portfolio-a",
    companyId: "company-a",
    resourceId: "resource-a",
    observedAt: "2026-09-20T20:59:00Z",
    nonce: `nonce-${kind}`,
    independentEvidenceId: "independent-proof"
  };
}

describe("Resource Fabric adversarial placeholders", () => {
  it("blocks resource impersonation without independent identity evidence", () => {
    expect(() => assessResourceFabricExternalClaim({
      ...claim("resource-identity"),
      independentEvidenceId: undefined
    }, scope, { now })).toThrow();
  });

  it("blocks fake enrollment readiness from becoming authority", () => {
    const result = assessResourceFabricExternalClaim(
      claim("enrollment-ready"),
      scope,
      { now }
    );
    expect(result.authoritative).toBe(false);
    expect(result.requiresControlPlaneDecision).toBe(true);
  });

  it("blocks forged heartbeat health without independent verification", () => {
    expect(() => assessResourceFabricExternalClaim({
      ...claim("heartbeat"),
      independentEvidenceId: undefined
    }, scope, { now })).toThrow();
  });

  it("blocks capacity spoofing without independent validation", () => {
    expect(() => assessResourceFabricExternalClaim({
      ...claim("capacity"),
      independentEvidenceId: undefined
    }, scope, { now })).toThrow();
  });

  it("rejects reservation replay", () => {
    const reservation = claim("reservation");
    expect(() => assessResourceFabricExternalClaim(
      reservation,
      scope,
      { now, seenNonces: new Set([reservation.nonce]) }
    )).toThrow();
  });

  it("prevents scheduler bypass by treating placement claims as evidence only", () => {
    const result = assessResourceFabricExternalClaim(claim("placement"), scope, { now });
    expect(result.authoritative).toBe(false);
    expect(result.acceptedAsEvidence).toBe(true);
  });
});
