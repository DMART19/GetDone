import { describe, expect, it } from "vitest";
import { commandFingerprint, createCommandEnvelope } from "@/lib/control-plane/command-envelope";

const scope = {
  userId: "user-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "staging" as const
};

describe("authoritative command envelope", () => {
  it("binds mutation to immutable trusted command metadata", () => {
    const command = createCommandEnvelope({
      commandId: "command-1",
      actor: { type: "user", id: "user-a" },
      scope,
      correlationId: "correlation-1",
      environment: "staging",
      idempotencyKey: "idempotency-1",
      provenance: "owner-ui",
      requestedMutation: { type: "goal.activate", targetId: "goal-1" }
    });
    expect(Object.isFrozen(command)).toBe(true);
    expect(commandFingerprint(command)).toHaveLength(64);
  });

  it("rejects environment mismatch", () => {
    expect(() => createCommandEnvelope({
      commandId: "command-1",
      actor: { type: "user", id: "user-a" },
      scope,
      correlationId: "correlation-1",
      environment: "production",
      idempotencyKey: "idempotency-1",
      provenance: "owner-ui",
      requestedMutation: { type: "goal.activate" }
    })).toThrow();
  });
});
