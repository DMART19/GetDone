import { describe, expect, it } from "vitest";
import {
  ADVERSARIAL_CONTRACT_VECTORS,
  assertAdversarialContractVectorSet
} from "@/lib/security/adversarial-contract-vectors";

describe("deterministic adversarial contract vectors", () => {
  it("keeps a unique machine-readable vector for every newly hardened boundary", () => {
    expect(assertAdversarialContractVectorSet()).toBe(ADVERSARIAL_CONTRACT_VECTORS);
    expect(new Set(ADVERSARIAL_CONTRACT_VECTORS.map((item) => item.boundary))).toEqual(
      new Set([
        "ai-gateway",
        "integration",
        "job-runtime",
        "business-adapter",
        "software-worker",
        "resource-fabric",
        "voice"
      ])
    );
  });

  it("explicitly preserves provider/model/frontend non-authority cases", () => {
    const expectations = ADVERSARIAL_CONTRACT_VECTORS.map((item) => item.expected).join("\n");
    expect(expectations).toMatch(/NO_ELIGIBLE_MODEL/);
    expect(expectations).toMatch(/jobStateMutationApplied=false/);
    expect(expectations).toMatch(/Production authorization transition fails closed/);
    expect(expectations).toMatch(/Dependency-boundary CI rejects/);
  });
});
