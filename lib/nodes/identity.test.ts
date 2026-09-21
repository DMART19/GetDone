import { describe, expect, it } from "vitest";
import {
  DevelopmentNodeIdentityIssuer
} from "@/lib/nodes/identity";

describe("DevelopmentNodeIdentityIssuer", () => {
  const signingFixture = "0123456789abcdef0123456789abcdef";

  it("issues and verifies a hash-bound development credential", async () => {
    const issuer = new DevelopmentNodeIdentityIssuer(signingFixture);
    const credential = await issuer.issue({
      nodeId: "node-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      publicKey: "public-key-material-for-node-1",
      issuedAt: "2026-09-21T12:00:00Z",
      expiresAt: "2026-09-22T12:00:00Z"
    });
    expect(credential.certificatePem).toContain("GETDONE DEVELOPMENT NODE CERTIFICATE");
    expect(await issuer.verify(credential)).toBe(true);
    expect(await issuer.verify({
      ...credential,
      nodeId: "node-tampered"
    })).toBe(false);
  });

  it("rotates to a distinct credential bound to the same node", async () => {
    const issuer = new DevelopmentNodeIdentityIssuer(signingFixture);
    const current = await issuer.issue({
      nodeId: "node-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      publicKey: "public-key-one",
      issuedAt: "2026-09-21T12:00:00Z",
      expiresAt: "2026-09-22T12:00:00Z"
    });
    const next = await issuer.rotate(current, {
      nodeId: current.nodeId,
      portfolioId: "portfolio-a",
      companyId: "company-a",
      publicKey: "public-key-two",
      issuedAt: "2026-09-21T18:00:00Z",
      expiresAt: "2026-09-22T18:00:00Z"
    });
    expect(next.nodeId).toBe(current.nodeId);
    expect(next.id).not.toBe(current.id);
    expect(next.serialNumber).not.toBe(current.serialNumber);
    expect(await issuer.verify(next)).toBe(true);
  });

  it("rejects short development signing secrets and invalid expiry", async () => {
    expect(() => new DevelopmentNodeIdentityIssuer("short"))
      .toThrow(/at least 32 bytes/i);
    const issuer = new DevelopmentNodeIdentityIssuer(signingFixture);
    await expect(issuer.issue({
      nodeId: "node-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      publicKey: "public-key",
      issuedAt: "2026-09-22T12:00:00Z",
      expiresAt: "2026-09-21T12:00:00Z"
    })).rejects.toThrow(/expiry/i);
  });
});
