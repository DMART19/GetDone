import { analyzeConversationMessage, type ConversationSemantics } from "./contracts";

export type ContinuityContext = {
  intentId: string;
  topic?: string;
  references: ConversationSemantics["references"];
  actionable: boolean;
};

export function isContextualFollowup(message: string): boolean {
  return /^(?:why\??|how\??|what about\s+.{1,100}|and\s+.{1,100}|fix (?:it|that)|do (?:it|that)|go ahead|proceed)[.!?]?$/i.test(message.trim());
}

/**
 * Previous context is evidence for interpretation only, never permission to execute.
 * Callers MUST supply only the previous turn from the same authorized user and
 * portfolio/company, and must re-authorize every subsequent tool request.
 */
export function resolveConversationContinuity(message: string, previous: ContinuityContext | null) {
  const semantics = analyzeConversationMessage(message);
  const contextual = isContextualFollowup(message);
  if (!contextual || !previous) return {
    semantics,
    continuesIntentId: undefined as string | undefined,
    activeTopic: contextual ? undefined : message.slice(0, 240),
    unresolved: contextual && !previous
  };
  const potentiallyActionable = semantics.continuation !== "none";
  if (potentiallyActionable && !previous.actionable) {
    return { semantics, continuesIntentId: undefined, activeTopic: previous.topic, unresolved: true };
  }
  const topic = /^what about\s+(.+?)[.!?]?$/i.exec(message.trim())?.[1]?.trim()
    ?? previous.topic;
  // A topic switch retains the trusted portfolio header, not an unrelated
  // integration/objective reference from the prior topic.
  const changesTopic = /^what about\s+/i.test(message.trim());
  const inherited = changesTopic
    ? previous.references.filter(reference => reference.kind === "company")
    : previous.references;
  const merged: ConversationSemantics = {
    ...semantics,
    references: semantics.references.length ? semantics.references : inherited
  };
  return { semantics: merged, continuesIntentId: previous.intentId, activeTopic: topic, unresolved: false };
}
