import { describe, expect, it } from "vitest";
import { attentionPriority } from "./attention-priority";
const now = Date.parse("2026-10-22T12:00:00Z");
const baseline = { urgency: .5, impact: .5, confidence: 1, createdAt: "2026-10-21T12:00:00Z" };
describe("advisory attention ranking", () => {
  it("raises owner decisions without authorizing an action", () => {
    expect(attentionPriority({...baseline, waitingForOwner:true},now)).toBeGreaterThan(attentionPriority(baseline,now));
  });
  it("deprioritizes blocked dependencies and high risk", () => {
    expect(attentionPriority({...baseline,blockedByDependency:true,risk:1},now)).toBeLessThan(attentionPriority(baseline,now));
  });
  it("treats malformed numeric signals as bounded rather than privileged", () => {
    expect(Number.isFinite(attentionPriority({...baseline,impact:Infinity,urgency:NaN},now))).toBe(true);
  });
  it("uses increasing age as a bounded tiebreaker", () => {
    expect(attentionPriority({...baseline,createdAt:"2026-10-01T12:00:00Z"},now)).toBeGreaterThan(attentionPriority(baseline,now));
  });
});
