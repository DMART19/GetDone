import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { ControlApiApplicationAdapter, OwnerIntentRecord } from "@/lib/control-api/contracts";
import { emptyState, interpret, prepareTurn, resolveBusiness, type ConversationState, type RegisteredBusiness } from "./understanding";
import { ControlPlaneError } from "@/lib/control-plane/errors";
export type TurnStatus = NonNullable<Awaited<ReturnType<NonNullable<ControlApiApplicationAdapter["getOwnerIntentStatus"]>>>>;
export interface ThreadTurn { record: OwnerIntentRecord; status: TurnStatus }
export function restoreState(turns: readonly ThreadTurn[]): ConversationState {
  const last = turns.at(-1);
  if (!last) return emptyState();
  const state = { ...(last.record.conversationState ?? emptyState()) };
  const sameBusiness = turns.filter(t => t.record.companyId === state.activeBusiness?.id && t.record.portfolioId === state.activeBusiness?.portfolioId);
  const activeWork = [...sameBusiness].reverse().find(t => t.status.decisions?.length);
  if (activeWork) {
    const decisions = activeWork.status.decisions!;
    state.approvalState = decisions.some(d => d.status === "pending") ? "pending"
      : decisions.every(d => d.status === "approved") ? "approved" : "rejected";
  }
  if (last.record.status === "accepted") {
    if (last.status.lifecycle.verified) {
      state.lastFinding = `${last.status.lifecycle.label}. Verification receipts: ${(last.status.verificationRefs ?? []).join(", ")}`;
      state.evidenceRefs = last.status.verificationRefs ?? [];
      state.selectedAction = undefined;
      state.proposedActions = [];
    } else if (last.status.lifecycle.terminal) {
      state.question = last.status.lifecycle.label;
      state.selectedAction = undefined;
    }
  }
  return state;
}
export function scopedRequest(request: Request, business: RegisteredBusiness) {
  const headers = new Headers(request.headers);
  headers.set("x-getdone-portfolio-id", business.portfolioId);
  return new Request(request.url, { headers });
}
export async function submitThreadTurn(input: {
  request: Request; message: string; threadId: string; idempotencyKey: string; correlationId: string;
  businesses: readonly RegisteredBusiness[]; turns: readonly ThreadTurn[];
  adapter: ControlApiApplicationAdapter;
  model?: (message: string, state: ConversationState) => Promise<unknown>;
}) {
  const requestKeyHash = sha256Hex(input.idempotencyKey);
  const replay = input.turns.find(t => t.record.requestKeyHash === requestKeyHash);
  if (replay) {
    if (replay.record.message !== input.message) throw new ControlPlaneError("IDEMPOTENCY_CONFLICT", "Retry key belongs to a different message");
    return replay.record;
  }
  const state = restoreState(input.turns);
  const interpretation = await interpret(input.message, input.model ? () => input.model!(input.message, state) : undefined);
  const candidates = resolveBusiness(input.message, input.businesses, state, interpretation.businessReference);
  const business = candidates.length === 1 ? candidates[0] : undefined;
  // A clarification can be persisted in an authorized scope, but cannot read
  // business evidence or enqueue work until resolution is unambiguous.
  const storageBusiness = business ?? input.businesses.find(b => b.portfolioId === state.activeBusiness?.portfolioId) ?? input.businesses[0];
  if (!storageBusiness) throw new ControlPlaneError("FORBIDDEN", "No registered business is accessible");
  const principal = await input.adapter.authenticate(scopedRequest(input.request, storageBusiness));
  const prepared = prepareTurn(input.message, interpretation, business, state, candidates);
  if (prepared.clarification && !business) prepared.state = { ...state, question: prepared.clarification };
  return input.adapter.submitOwnerIntent(principal, { message: input.message, channel: "chat" }, input.idempotencyKey,
    input.correlationId, { threadId: input.threadId, requestKeyHash, ...prepared });
}
