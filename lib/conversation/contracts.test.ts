import { describe, expect, it } from "vitest";
import { analyzeConversationMessage, classifyConversationIntent, resolveConversationReferences } from "@/lib/conversation/contracts";
import { ownerLifecycleFromRun } from "@/lib/conversation/owner-lifecycle";
import type { OrchestrationRunRecord, OrchestrationState } from "@/lib/orchestration/contracts";

describe("conversation boundary", () => {
  it.each([
    ["How's GetDone?", "status_query"],
    ["Why is GitHub disconnected?", "explain_query"],
    ["Investigate the webhook failures", "investigate_request"],
    ["What should we do about revenue?", "recommend_request"],
    ["Fix the webhook", "action_request"],
    ["Grow revenue to $10k MRR", "objective_request"],
    ["hello", "ambiguous"],
    ["", "ambiguous"]
  ] as const)("%s -> %s", (message, expected) => expect(classifyConversationIntent(message)).toBe(expected));

  it("resolves bounded named references without inventing entities", () => {
    expect(resolveConversationReferences("Is GitHub connected for GetDone and Slack?")).toEqual([
      { kind: "integration", name: "GitHub" },
      { kind: "integration", name: "Slack" },
      { kind: "company", name: "GetDone" }
    ]);
    expect(resolveConversationReferences("what about revenue?")).toEqual([]);
  });

  it("treats fix it and do it as continuations that still require authority", () => {
    expect(analyzeConversationMessage("Fix it")).toMatchObject({ continuation: "fix-it", requiresExecutionAuthority: true });
    expect(analyzeConversationMessage("Do it")).toMatchObject({ continuation: "do-it", requiresExecutionAuthority: true });
  });
  it("covers intent precedence, punctuation continuations, deduplication, and authority semantics", () => {
    expect(classifyConversationIntent("Why is the webhook failing?")).toBe("investigate_request");
    expect(classifyConversationIntent("How should we fix revenue?")).toBe("recommend_request");
    expect(classifyConversationIntent("Please deploy the release")).toBe("action_request");
    expect(classifyConversationIntent("Improve release readiness")).toBe("objective_request");
    expect(classifyConversationIntent("What is revenue?")).toBe("status_query");

    expect(resolveConversationReferences("github GitHub GITHUB for OpsManagerPro opsmanagerpro")).toEqual([
      { kind: "integration", name: "github" },
      { kind: "company", name: "OpsManagerPro" }
    ]);

    expect(analyzeConversationMessage("  Go ahead!  ")).toMatchObject({
      intent: "action_request",
      continuation: "do-it",
      requiresExecutionAuthority: true
    });
    expect(analyzeConversationMessage("Grow revenue")).toMatchObject({
      intent: "objective_request",
      continuation: "none",
      requiresExecutionAuthority: true
    });
    expect(analyzeConversationMessage("Is Slack connected?")).toMatchObject({
      intent: "status_query",
      continuation: "none",
      requiresExecutionAuthority: false
    });
  });

});

describe("owner lifecycle", () => {
  const run = (state: OrchestrationState, extra: Partial<Pick<OrchestrationRunRecord, "blockedReason" | "failure">> = {}) => ({ state, ...extra });
  it.each([
    ["accepted", "answering", false], ["context-ready", "answering", false], ["planning", "answering", false],
    ["planned", "proposed_work", false], ["validated", "proposed_work", false], ["policy-evaluated", "proposed_work", false],
    ["awaiting-decision", "awaiting_approval", false], ["authorized", "running", false], ["tasks-created", "running", false],
    ["jobs-enqueued", "running", false], ["executing", "running", false], ["verifying", "verifying", false],
    ["completed", "verified", true], ["blocked", "blocked", false], ["failed", "failed", false], ["cancelled", "blocked", false]
  ] as const)("maps %s truthfully", (state, expected, verified) => {
    expect(ownerLifecycleFromRun(run(state))).toMatchObject({ state: expected, verified });
  });
  it("surfaces owner-safe terminal summaries", () => {
    expect(ownerLifecycleFromRun(run("blocked", { blockedReason: "Approval expired" })).label).toBe("Approval expired");
    expect(ownerLifecycleFromRun(run("failed", { failure: { code: "PROVIDER_UNAVAILABLE", message: "Provider unavailable", retryable: true, failedAt: "2026-10-05T09:00:00.000Z" } })).label).toBe("Provider unavailable");
  });
});
