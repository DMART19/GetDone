import { describe, expect, it } from "vitest";
import { ownerOutcomeMessage } from "./outcome-message";
describe("owner outcome communication", () => {
  it("does not infer completion from provider status", () => {
    expect(ownerOutcomeMessage({label:"Provider completed",terminal:false,verified:false}))
      .toContain("no verified completion");
  });
  it("requires a receipt before communicating independently verified success", () => {
    expect(ownerOutcomeMessage({label:"Draft saved",terminal:true,verified:true,verificationRefs:["receipt-1"]}))
      .toContain("independently verified");
    expect(ownerOutcomeMessage({label:"Draft saved",terminal:true,verified:true}))
      .toContain("no receipt");
  });
  it("reports failed terminal work without claiming success", () => {
    expect(ownerOutcomeMessage({label:"Task failed",terminal:true,verified:false}))
      .toContain("without a verified outcome");
  });
});
