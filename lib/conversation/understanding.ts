import { z } from "zod";
import { analyzeConversationMessage, type ConversationSemantics } from "./contracts";

export const interpretationSchema = z.object({
  intent: z.enum(["status_query", "explain_query", "investigate_request", "recommend_request", "action_request", "objective_request", "ambiguous"]),
  confidence: z.number().min(0).max(1),
  businessReference: z.string().max(200).nullable(),
  topic: z.enum(["revenue", "deployment", "marketing", "customers", "health"]).nullable(),
  asksForAction: z.boolean(),
  needsClarification: z.boolean()
}).strict();
export type Interpretation = z.infer<typeof interpretationSchema> & { source: "model" | "deterministic" };
export interface RegisteredBusiness { id: string; portfolioId: string; name: string; aliases?: readonly string[]; description?: string }
export interface ProposedAction { id: string; description: string; sourceIntentId: string }
export interface ConversationState {
  activeBusiness?: RegisteredBusiness;
  activeTopic?: Interpretation["topic"];
  question?: string;
  currentQuestion?: string;
  lastFinding?: string;
  proposedActions: readonly ProposedAction[];
  selectedAction?: ProposedAction;
  approvalState: "none" | "pending" | "approved" | "rejected";
  evidenceRefs: readonly string[];
}
export const emptyState = (): ConversationState => ({ proposedActions: [], approvalState: "none", evidenceRefs: [] });
export function topicFor(message: string): Interpretation["topic"] {
  if (/revenue|sales|mrr|profit|financial|billing/i.test(message)) return "revenue";
  if (/deploy|infrastructure|error|release|server|uptime/i.test(message)) return "deployment";
  if (/marketing|campaign|landing page|positioning|acquisition/i.test(message)) return "marketing";
  if (/customer|support|crm|feedback|usage/i.test(message)) return "customers";
  return null;
}
export async function interpret(message: string, model?: () => Promise<unknown>): Promise<Interpretation> {
  if (model) {
    try {
      const parsed = interpretationSchema.safeParse(await model());
      if (parsed.success && parsed.data.confidence >= 0.75) return { ...parsed.data, source: "model" };
    } catch { /* An unavailable or invalid model cannot grant authority. */ }
  }
  const fallback = analyzeConversationMessage(message);
  return { intent: fallback.intent, confidence: fallback.intent === "ambiguous" ? 0.2 : 0.65,
    businessReference: null, topic: topicFor(message), asksForAction: fallback.requiresExecutionAuthority,
    needsClarification: fallback.intent === "ambiguous", source: "deterministic" };
}
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const contains = (text: string, name: string) => Boolean(normalize(name)) && (` ${normalize(text)} `).includes(` ${normalize(name)} `);
export function resolveBusiness(message: string, businesses: readonly RegisteredBusiness[], state: ConversationState, reference?: string | null) {
  const named = businesses.filter(b => [b.name, ...(b.aliases ?? [])].some(name => contains(message, name)));
  if (named.length) return named;
  const extracted = message.match(/(?:how(?:'s| is)|what about|tell me about|switch to)\s+(.+?)[?!.]*$/i)?.[1];
  const query = normalize(reference || extracted || message);
  const words = query.split(" ").filter(w => w.length > 2 && !["the", "app", "business", "about", "what", "that", "how", "does", "please", "how", "doing", "tell", "about", "is", "check"].includes(w));
  const described = businesses.filter(b => {
    if (reference && [b.name, ...(b.aliases ?? [])].some(name => normalize(name) === query)) return true;
    return words.length > 0 && Boolean(b.description) && words.every(w => contains(b.description!, w));
  });
  if (described.length) return described;
  // An explicit unknown reference must not silently reuse the active business.
  if (reference && !/^(it|that business|this business)$/i.test(reference)) return [];
  if (/\b(?:what about|how(?:'s| is))\s+/i.test(message) && !topicFor(message)
    && !/\b(it|that business|this business|everything)\b/i.test(message)) return [];
  const active = businesses.find(b => b.id === state.activeBusiness?.id && b.portfolioId === state.activeBusiness.portfolioId);
  return active ? [active] : businesses.length === 1 ? [...businesses] : [];
}
export function prepareTurn(message: string, interpreted: Interpretation, business: RegisteredBusiness | undefined,
  previous: ConversationState, candidates: readonly RegisteredBusiness[]) {
  const switched = business?.id !== previous.activeBusiness?.id || business?.portfolioId !== previous.activeBusiness?.portfolioId;
  const topicChanged = Boolean(interpreted.topic && previous.activeTopic && interpreted.topic !== previous.activeTopic);
  const state: ConversationState = { ...(switched || topicChanged ? emptyState() : previous), activeBusiness: business,
    activeTopic: interpreted.topic ?? (switched ? "health" : previous.activeTopic) ?? "health", question: undefined, currentQuestion: message };
  const deterministic = analyzeConversationMessage(message);
  const semantics: ConversationSemantics = { ...deterministic, intent: interpreted.intent,
    references: [...deterministic.references.filter(ref => ref.kind !== "company"), ...(business ? [{ kind: "company" as const, name: business.name }] : [])],
    confidence: interpreted.confidence, topic: state.activeTopic ?? undefined, businessId: business?.id, businessReference: interpreted.businessReference ?? business?.name,
    interpretationSource: interpreted.source, needsClarification: interpreted.needsClarification,
    asksForAction: interpreted.asksForAction,
    requiresExecutionAuthority: deterministic.continuation !== "none" || interpreted.asksForAction || ["action_request", "objective_request"].includes(interpreted.intent) };
  const refersToAction = deterministic.continuation !== "none"
    || (semantics.requiresExecutionAuthority && /\b(it|that|this|those|them|ahead|proceed)\b/i.test(message));
  if (refersToAction && semantics.continuation === "none") semantics.continuation = /\bfix\b/i.test(message) ? "fix-it" : "do-it";
  let clarification: string | undefined;
  if (!business) clarification = candidates.length > 1
    ? `Which business do you mean: ${candidates.map(b => b.name).join(", ")}?`
    : "Which registered business do you mean? Please give its name.";
  else if (refersToAction) {
    const selected = state.selectedAction ?? (state.proposedActions.length === 1 ? state.proposedActions[0] : undefined);
    if (!selected) clarification = state.proposedActions.length > 1
      ? `Which fix do you mean? ${state.proposedActions.map((a, i) => `${i + 1}. ${a.description}`).join(" ")}`
      : "What specifically should I fix? There is no selected action in this conversation.";
    else state.selectedAction = selected;
  } else if (/^(?:the )?(?:first|second|[12])(?: one| fix)?[.!]?$/i.test(message) && state.proposedActions.length) {
    state.selectedAction = state.proposedActions[/second|2/i.test(message) ? 1 : 0];
    clarification = state.selectedAction ? `Selected: ${state.selectedAction.description}. Ask me to prepare that action when ready.` : "Which proposed action do you mean?";
  } else if (interpreted.intent === "explain_query" && /^why[?! .]*$/i.test(message) && !state.lastFinding) {
    clarification = "Which finding would you like me to explain?";
  } else if (interpreted.needsClarification && previous.question?.startsWith("Which business") && business) {
    semantics.intent = "status_query";
    semantics.needsClarification = false;
  } else if (interpreted.needsClarification) clarification = "What would you like to know or change about this business?";
  if (clarification) {
    state.question = clarification;
    semantics.needsClarification = true;
  }
  return { semantics, state, clarification };
}
