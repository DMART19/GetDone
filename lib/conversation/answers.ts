import type { OwnerIntentRecord } from "@/lib/control-api/contracts";
import { assembleContext, type ContextItem } from "@/lib/intelligence/context";
import { missingEvidence, relevance } from "./evidence";
import { redactTelemetryText } from "@/lib/observability/telemetry";
export interface AnswerEvidenceRow { id: string; entity_type: string; updated_at: string; title: string; state: string; sensitivity: ContextItem["sensitivity"] }
export function groundConversationAnswer(record: OwnerIntentRecord, rows: readonly AnswerEvidenceRow[]): OwnerIntentRecord {
  const intent = record.conversation?.intent;
  const topic = record.conversationState?.activeTopic ?? record.conversation?.topic;
  const context = assembleContext(rows.map(row => ({
    id: `${row.entity_type}:${row.id}`, kind: "fact" as const,
    portfolioId: record.portfolioId, companyId: record.companyId,
    source: row.entity_type, provenance: "control-plane", observedAt: new Date(row.updated_at).toISOString(),
    freshnessSeconds: 7 * 86400, sensitivity: row.sensitivity,
    content: redactTelemetryText(`${row.title}: ${row.state}`)
  })), { portfolioId: record.portfolioId, companyId: record.companyId, allowedSensitivity: ["public", "internal"] },
  { question: topic ?? record.message, now: Date.parse(record.receivedAt), maxItems: 6 });
  const evidence = context.items.filter(item => !topic || topic === "health" || relevance(item, topic) > 0);
  const missing = missingEvidence(topic);
  const primaryFinding = evidence[0]?.content;
  let text = primaryFinding ? `The main recorded finding is ${primaryFinding}.` : missing;
  if (evidence.length > 1) text += ` Other relevant records: ${evidence.slice(1).map(item => item.content).join(". ")}.`;
  if (intent === "explain_query" && evidence.length) {
    text = `${record.conversationState?.lastFinding ? `You asked about: ${record.conversationState.lastFinding}. ` : ""}Current supporting records: ${text}. These records establish status, not a verified root cause; diagnostic evidence is still needed.`;
  }
  const proposedActions = intent === "recommend_request" && evidence.length ? [
    { id: `${record.id}:investigate`, description: `Investigate the ${topic ?? "business"} findings using read-only evidence`, sourceIntentId: record.id },
    { id: `${record.id}:draft`, description: `Prepare a draft improvement plan for ${topic ?? "business health"}; do not publish or modify external systems`, sourceIntentId: record.id }
  ] : record.conversationState?.proposedActions ?? [];
  if (intent === "recommend_request" && evidence.length) text += ` Suggested next steps: ${proposedActions.map((action, i) => `${i + 1}. ${action.description}`).join(" ")}. Which would you like to pursue?`;
  return Object.freeze({ ...record, status: "answered" as const,
    conversationState: record.conversationState ? { ...record.conversationState,
      lastFinding: primaryFinding, evidenceRefs: evidence.map(item => item.id), proposedActions } : undefined,
    answer: { text, evidenceRefs: evidence.map(item => item.id), observedAt: record.receivedAt,
      knownUnknowns: evidence.length ? (intent === "explain_query" ? ["Root cause has not been verified"] : []) : [missing] }
  });
}
