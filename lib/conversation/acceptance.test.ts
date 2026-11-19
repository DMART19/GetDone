import { describe, expect, it, vi } from "vitest";
import { emptyState, interpret, prepareTurn, resolveBusiness, type ConversationState, type RegisteredBusiness } from "./understanding";
import { groundConversationAnswer, type AnswerEvidenceRow } from "./answers";
import { scopedRequest, restoreState, submitThreadTurn, type ThreadTurn } from "./thread-service";
import { assembleContext, type ContextItem } from "@/lib/intelligence/context";
import type { ControlApiApplicationAdapter, OwnerIntentRecord } from "@/lib/control-api/contracts";

const businesses: RegisteredBusiness[] = [
  { id: "ops", portfolioId: "p-ops", name: "OpsManagerPro", aliases: ["OMP"], description: "warehouse app for inventory and logistics" },
  { id: "getdone", portfolioId: "p-getdone", name: "GetDone", aliases: ["GD"], description: "business conversational operating interface" }
];
const now = "2026-10-11T20:00:00.000Z";
function record(state: ConversationState, intent: OwnerIntentRecord["conversation"]): OwnerIntentRecord {
  return { id: "turn-1", threadId: "thread", portfolioId: "p-ops", companyId: "ops", userId: "owner", environment: "staging",
    message: "How's OpsManagerPro?", channel: "chat", status: "accepted", receivedAt: now, conversation: intent, conversationState: state };
}
const evidence = (id: string, title: string, state = "failed", sensitivity: AnswerEvidenceRow["sensitivity"] = "internal"): AnswerEvidenceRow => ({ id, title, state, sensitivity, entity_type: "outcome", updated_at: now });
async function turn(message: string, previous = emptyState()) {
  const interpretation = await interpret(message);
  const candidates = resolveBusiness(message, businesses, previous, interpretation.businessReference);
  return prepareTurn(message, interpretation, candidates.length === 1 ? candidates[0] : undefined, previous, candidates);
}
function asTurn(value: OwnerIntentRecord): ThreadTurn {
  return { record: value, status: { intentId: value.id, conversation: value.conversation!, answer: value.answer,
    lifecycle: { state: "answer", label: "Answered", terminal: true, verified: false } } };
}

describe("conversational operating interface acceptance", () => {
  it("How's OpsManagerPro -> Why retains business and the finding being questioned", async () => {
    const first = await turn("How's OpsManagerPro?");
    const answer = groundConversationAnswer(record(first.state, first.semantics), [evidence("release", "Deployment")]);
    const followup = await turn("Why?", answer.conversationState);
    expect(followup.state.activeBusiness?.id).toBe("ops");
    expect(followup.state.lastFinding).toContain("Deployment: failed");
    expect(followup.semantics.intent).toBe("explain_query");
    const explanation = groundConversationAnswer({ ...record(followup.state, followup.semantics), message: "Why?" }, [evidence("release", "Deployment")]);
    expect(explanation.answer?.text).toContain("not a verified root cause");
  });
  it("marketing changes topic, prioritizes relevant evidence and does not carry an old finding", async () => {
    const state = { ...emptyState(), activeBusiness: businesses[0], activeTopic: "deployment" as const, lastFinding: "Deploy failed" };
    const next = await turn("What about marketing?", state);
    expect(next.state.activeBusiness?.id).toBe("ops");
    expect(next.state.lastFinding).toBeUndefined();
    expect(next.state.activeTopic).toBe("marketing");
    const answer = groundConversationAnswer(record(next.state, next.semantics), [evidence("deploy", "Deployment"), evidence("campaign", "Marketing campaign", "under review")]);
    expect(answer.answer?.evidenceRefs).toEqual(["outcome:campaign"]);
    expect(answer.answer?.text).not.toContain("Deployment");
  });
  it("switches to GetDone and clears findings, proposals, selected action, approvals and evidence", async () => {
    const first = await turn("How's OpsManagerPro?");
    const next = await turn("What about GetDone?", { ...first.state, lastFinding: "Old finding", approvalState: "approved", evidenceRefs: ["old"],
      proposedActions: [{ id: "old", description: "Old fix", sourceIntentId: "old" }] });
    expect(next.state).toMatchObject({ activeBusiness: businesses[1], proposedActions: [], evidenceRefs: [], approvalState: "none" });
    expect(next.state.lastFinding).toBeUndefined();
  });
  it("two proposed fixes require explicit selection; selection is not approval", async () => {
    const state: ConversationState = { ...emptyState(), activeBusiness: businesses[0], proposedActions: [
      { id: "one", description: "Repair deployment", sourceIntentId: "source" },
      { id: "two", description: "Update campaign draft", sourceIntentId: "source" }
    ] };
    const ambiguous = await turn("Fix that", state);
    expect(ambiguous.clarification).toContain("Which fix");
    expect((await turn("Could you fix that for me?", state)).clarification).toContain("Which fix");
    expect(ambiguous.state.selectedAction).toBeUndefined();
    const selection = await turn("first", ambiguous.state);
    expect(selection.state.selectedAction?.id).toBe("one");
    expect(selection.state.approvalState).toBe("none");
    const request = await turn("Fix that", selection.state);
    expect(request.clarification).toBeUndefined();
    expect(request.semantics.requiresExecutionAuthority).toBe(true);
  });
  it("reopens serialized messages and state, reconstructing approval status from authority", async () => {
    const first = await turn("How's OpsManagerPro?");
    const answer = groundConversationAnswer(record(first.state, first.semantics), [evidence("release", "Deployment")]);
    const turns = JSON.parse(JSON.stringify([asTurn(answer)])) as ThreadTurn[];
    turns[0].status.decisions = [{ id: "decision", status: "pending", requiresStepUp: true }];
    expect(restoreState(turns)).toMatchObject({ activeBusiness: businesses[0], lastFinding: "Deployment: failed", approvalState: "pending", evidenceRefs: ["outcome:release"] });
    expect(turns[0].record.message).toBe("How's OpsManagerPro?");
    expect(turns[0].status.answer?.text).toContain("Deployment: failed");
  });
  it("revenue without financial data names the missing connection without inventing revenue", async () => {
    const next = await turn("What about revenue?", { ...emptyState(), activeBusiness: businesses[0] });
    const answer = groundConversationAnswer(record(next.state, next.semantics), [evidence("deploy", "Deployment", "healthy")]);
    expect(answer.answer?.text).toContain("Connect a billing/accounting source or CRM");
    expect(answer.answer?.evidenceRefs).toEqual([]);
    expect(answer.answer?.knownUnknowns).toHaveLength(1);
  });
  it("resolves arbitrary registered names, aliases, descriptions and pronouns; ambiguous matches stop", () => {
    const catalog = [{ id: "custom", portfolioId: "p-custom", name: "Acme Logistics", aliases: ["AL"], description: "warehouse app" }];
    for (const message of ["How's Acme Logistics?", "How's AL?", "How's the warehouse app?"]) expect(resolveBusiness(message, catalog, emptyState())).toEqual(catalog);
    expect(resolveBusiness("How is it?", catalog, { ...emptyState(), activeBusiness: catalog[0] })).toEqual(catalog);
    expect(resolveBusiness("How's the warehouse app?", [...catalog, businesses[0]], emptyState())).toHaveLength(2);
    expect(resolveBusiness("How's UnknownCo?", catalog, { ...emptyState(), activeBusiness: catalog[0] })).toEqual([]);
    expect(resolveBusiness("Compare AL and OpsManagerPro", [...catalog, businesses[0]], emptyState())).toHaveLength(2);
  });
  it("uses semantic output, falls back for low confidence, malformed, unavailable and hostile output", async () => {
    const valid = { intent: "investigate_request", confidence: 0.94, businessReference: null, topic: "revenue", asksForAction: false, needsClarification: false };
    expect(await interpret("Something feels off with cash coming in", async () => valid)).toMatchObject({ intent: "investigate_request", source: "model" });
    for (const output of [{ ...valid, confidence: 0.2 }, { ...valid, approval: "approved" }, { intent: "execute_without_policy" }]) {
      expect(await interpret("Fix that", async () => output)).toMatchObject({ source: "deterministic", asksForAction: true });
    }
    expect(await interpret("Why?", async () => { throw new Error("unavailable"); })).toMatchObject({ intent: "explain_query", source: "deterministic" });
  });
  it("filters tenant, sensitivity and resource authorization before relevance ranking", () => {
    const item: ContextItem = { id: "allowed", kind: "fact", portfolioId: "p", companyId: "c", source: "sales", provenance: "test", observedAt: now, freshnessSeconds: 3600, sensitivity: "internal", content: "Revenue fell" };
    const candidates: ContextItem[] = [item, { ...item, id: "other", companyId: "other" }, { ...item, id: "sensitive", sensitivity: "sensitive" },
      { ...item, id: "resource", kind: "resource-summary", resourceId: "forbidden" }, { ...item, id: "stale", observedAt: "2020-01-01T00:00:00Z" }];
    const result = assembleContext(candidates, { portfolioId: "p", companyId: "c", allowedSensitivity: ["internal"] }, { now: Date.parse(now), question: "revenue" });
    expect(result.items.map(i => i.id)).toEqual(["allowed"]);
    expect(result.excluded).toMatchObject({ unauthorizedScope: 1, sensitivity: 1, resourceScope: 1, stale: 1 });
  });
  it("reauthorizes a resolved business before admitting an action; never calls decision approval", async () => {
    const authenticate = vi.fn().mockRejectedValue(new Error("membership revoked"));
    const submitOwnerIntent = vi.fn();
    await expect(submitThreadTurn({ request: new Request("https://test/chat"), message: "Deploy GetDone", threadId: "t", idempotencyKey: "key", correlationId: "c",
      businesses, turns: [], adapter: { authenticate, submitOwnerIntent } as unknown as ControlApiApplicationAdapter })).rejects.toThrow("membership revoked");
    expect(submitOwnerIntent).not.toHaveBeenCalled();
    expect(authenticate.mock.calls[0][0].headers.get("x-getdone-portfolio-id")).toBe("p-getdone");
    expect(scopedRequest(new Request("https://test", { headers: { cookie: "session=s", "x-getdone-portfolio-id": "spoofed" } }), businesses[0]).headers.get("x-getdone-portfolio-id")).toBe("p-ops");
  });
});

it("does not reselect already verified work and exposes verification as the next finding", () => {
  const state: ConversationState = { ...emptyState(), activeBusiness: businesses[0], selectedAction: { id: "one", description: "Draft", sourceIntentId: "source" },
    proposedActions: [{ id: "one", description: "Draft", sourceIntentId: "source" }] };
  const value = asTurn(record(state, { intent: "action_request", references: [], continuation: "do-it", requiresExecutionAuthority: true }));
  value.status.lifecycle = { state: "verified", label: "Verified complete", terminal: true, verified: true };
  value.status.verificationRefs = ["receipt:one"];
  expect(restoreState([value])).toMatchObject({ selectedAction: undefined, proposedActions: [], evidenceRefs: ["receipt:one"] });
  expect(restoreState([value]).lastFinding).toContain("Verified complete");
});
