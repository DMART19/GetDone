import { describe, expect, it } from "vitest";
import { parseDecisionActionRequest } from "@/lib/control-plane/schemas";

describe("control API validation", () => {
  it("accepts a typed decision action", () => {
    expect(parseDecisionActionRequest({ decisionId: "decision-1", action: "approve" })).toEqual({
      decisionId: "decision-1",
      action: "approve",
      note: undefined
    });
  });

  it("rejects invalid actions and unsafe ids", () => {
    expect(() => parseDecisionActionRequest({ decisionId: "../other", action: "approve" })).toThrow();
    expect(() => parseDecisionActionRequest({ decisionId: "decision-1", action: "force" })).toThrow();
  });
});
