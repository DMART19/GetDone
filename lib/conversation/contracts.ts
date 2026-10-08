export type ConversationIntent =
  | "status_query"
  | "explain_query"
  | "investigate_request"
  | "recommend_request"
  | "action_request"
  | "objective_request"
  | "ambiguous";

export type ConversationEntityKind = "company" | "objective" | "integration" | "resource";

export interface ConversationEntityReference {
  kind: ConversationEntityKind;
  name: string;
}

export interface ConversationSemantics {
  intent: ConversationIntent;
  references: readonly ConversationEntityReference[];
  continuation: "none" | "fix-it" | "do-it";
  requiresExecutionAuthority: boolean;
}

const ACTION = /\b(fix|do|create|update|change|send|publish|deploy|merge|delete|connect|disconnect|run|execute|implement|ship)\b/i;
const OBJECTIVE = /\b(goal|objective|increase|reduce|grow|launch|improve|make .* better)\b/i;
const INVESTIGATE = /\b(investigate|diagnose|find out|root cause|look into|why is .* failing)\b/i;
const RECOMMEND = /\b(recommend|what should|best way|suggest|how should)\b/i;
const EXPLAIN = /\b(why|explain|how does|what does)\b/i;
const STATUS = /\b(status|how(?:'s| is)|what(?:'s| is) happening|connected|working|running|done|finished|health)\b/i;

export function classifyConversationIntent(message: string): ConversationIntent {
  const value = message.trim();
  if (!value) return "ambiguous";
  if (/^(fix it|fix that|do it|do that|go ahead|proceed)[.!]?$/i.test(value)) return "action_request";
  if (INVESTIGATE.test(value)) return "investigate_request";
  if (RECOMMEND.test(value)) return "recommend_request";
  // Questions about actions are explanations, not permission to perform them.
  if (EXPLAIN.test(value)) return "explain_query";
  if (ACTION.test(value)) return "action_request";
  if (OBJECTIVE.test(value)) return "objective_request";
  if (STATUS.test(value) || value.endsWith("?")) return "status_query";
  return "ambiguous";
}

export function resolveConversationReferences(message: string): readonly ConversationEntityReference[] {
  const refs: ConversationEntityReference[] = [];
  const patterns: Array<[ConversationEntityKind, RegExp]> = [
    ["integration", /\b(GitHub|Gmail|Slack|HubSpot|Stripe|OpenRouter|Notion|Salesforce|Shopify|Jira|Linear)\b/gi],
    ["company", /\b(GetDone|OpsManagerPro|StatusWatchPro)\b/gi]
  ];
  for (const [kind, pattern] of patterns) {
    for (const match of message.matchAll(pattern)) {
      if (!refs.some((item) => item.kind === kind && item.name.toLowerCase() === match[0].toLowerCase())) {
        refs.push(Object.freeze({ kind, name: match[0] }));
      }
    }
  }
  return Object.freeze(refs);
}

export function analyzeConversationMessage(message: string): ConversationSemantics {
  const intent = classifyConversationIntent(message);
  const continuation = /^\s*fix (?:it|that)[.!]?\s*$/i.test(message)
    ? "fix-it" as const
    : /^\s*(?:do (?:it|that)|go ahead|proceed)[.!]?\s*$/i.test(message)
      ? "do-it" as const
      : "none" as const;
  return Object.freeze({
    intent,
    references: resolveConversationReferences(message),
    continuation,
    requiresExecutionAuthority: ["action_request", "objective_request"].includes(intent)
  });
}
