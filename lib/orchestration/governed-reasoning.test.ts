import { describe, expect, it } from "vitest";
import type { PlannerInputEnvelope } from "./planning-flow";
import { boundedReasoningHandoffs } from "./governed-reasoning";

const now = "2026-10-22T12:00:00Z";
const scope = {userId:"owner",portfolioId:"portfolio",companyId:"business",environment:"staging"};
const stub = (items: unknown[]) => ({
  createdAt:now, scope,
  context:{items}
}) as unknown as PlannerInputEnvelope;
const item = (id:string, companyId:string, observedAt=now)=>({
  id,portfolioId:"portfolio",companyId,observedAt,freshnessSeconds:86400,
  kind:"fact",sensitivity:"internal",source:"business",provenance:"test",content:"revenue"
});
describe("bounded AI Gateway handoffs",()=>{
 it("caps role count and stays non-authoritative",()=>{
  const handoffs=boundedReasoningHandoffs(stub([item("valid","business")]),{maxHandoffs:100});
  expect(handoffs.map(h=>h.role)).toEqual(["researcher","strategist","planner"]);
  for(const h of handoffs)expect(h).toMatchObject({mayExecute:false,mayAuthorize:false,mayVerifyOutcome:false});
 });
 it("never passes foreign or stale context into role handoffs",()=>{
  const h=boundedReasoningHandoffs(stub([item("valid","business"),item("foreign","other"),item("stale","business","2025-01-01T12:00:00Z")]));
  expect(h[0].contextIds).toEqual(["valid"]);
 });
 it("respects zero-handoff mode",()=>{
  expect(boundedReasoningHandoffs(stub([]),{maxHandoffs:0})).toEqual([]);
 });
});
