import type { OrchestrationRunRecord } from "@/lib/orchestration/contracts";

export type OwnerLifecycleState =
  | "answering"
  | "answer"
  | "proposed_work"
  | "awaiting_approval"
  | "running"
  | "blocked"
  | "verifying"
  | "failed"
  | "verified";

export interface OwnerLifecycleView {
  state: OwnerLifecycleState;
  label: string;
  terminal: boolean;
  verified: boolean;
}

export function ownerLifecycleFromRun(run: Pick<OrchestrationRunRecord, "state" | "blockedReason" | "failure">): OwnerLifecycleView {
  switch (run.state) {
    case "accepted":
    case "context-ready":
    case "planning":
      return { state: "answering", label: "Understanding your request", terminal: false, verified: false };
    case "planned":
    case "validated":
    case "policy-evaluated":
      return { state: "proposed_work", label: "Work proposed", terminal: false, verified: false };
    case "awaiting-decision":
      return { state: "awaiting_approval", label: "Waiting for your approval", terminal: false, verified: false };
    case "authorized":
    case "tasks-created":
    case "jobs-enqueued":
    case "executing":
      return { state: "running", label: "Running", terminal: false, verified: false };
    case "verifying":
      return { state: "verifying", label: "Verifying the result", terminal: false, verified: false };
    case "completed":
      return { state: "verified", label: "Verified complete", terminal: true, verified: true };
    case "blocked":
      return { state: "blocked", label: run.blockedReason?.trim() || "Blocked", terminal: true, verified: false };
    case "failed":
      return { state: "failed", label: run.failure?.message?.trim() || "Failed", terminal: true, verified: false };
    case "cancelled":
      return { state: "blocked", label: "Cancelled", terminal: true, verified: false };
  }
}
