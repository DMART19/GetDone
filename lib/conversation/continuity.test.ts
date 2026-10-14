import { describe, expect, it } from "vitest";
import { isContextualFollowup, resolveConversationContinuity } from "./continuity";

const previous = {
  intentId: "intent-a",
  topic: "Why is the Github integration delayed?",
  references: [{ kind: "integration" as const, name: "GitHub" }],
  actionable: false
};
describe("durable tenant-scoped conversation continuation semantics", () => {
  it("recognizes short references without granting authority", () => {
    expect(isContextualFollowup("Why?")).toBe(true);
    expect(isContextualFollowup("What about marketing?")).toBe(true);
    expect(isContextualFollowup("Fix that")).toBe(true);
    const why = resolveConversationContinuity("Why?", previous);
    expect(why.continuesIntentId).toBe("intent-a");
    expect(why.semantics.references).toEqual(previous.references);
    expect(why.semantics.requiresExecutionAuthority).toBe(false);
  });
  it("preserves business references while switching topic", () => {
    const next = resolveConversationContinuity("What about marketing?", previous);
    expect(next.activeTopic).toBe("marketing");
    expect(next.semantics.references).toEqual(previous.references);
  });
  it("does not execute a follow-up without a verified actionable proposal", () => {
    const next = resolveConversationContinuity("Fix that", previous);
    expect(next.unresolved).toBe(true);
    expect(next.continuesIntentId).toBeUndefined();
  });
  it("asks for clarification without a previous scoped turn", () => {
    const next = resolveConversationContinuity("Why?", null);
    expect(next.unresolved).toBe(true);
  });
  it("does not inherit previous references on new explicit requests", () => {
    const next = resolveConversationContinuity("Is Slack connected?", previous);
    expect(next.continuesIntentId).toBeUndefined();
    expect(next.semantics.references).toEqual([{ kind: "integration", name: "Slack" }]);
  });
});
