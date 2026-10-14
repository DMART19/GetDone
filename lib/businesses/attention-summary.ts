import type { BusinessContext, BusinessSection } from "./contracts";

export type AttentionKind = "approval" | "owner_input" | "blocked" | "review";
export type AttentionItem = {
  id: string;
  title: string;
  section: BusinessSection;
  status: string;
  kind: AttentionKind;
};

const approvalStates = new Set(["pending", "awaiting_approval", "pending_approval"]);
const ownerInputStates = new Set(["needs_owner_input", "awaiting_owner_input", "owner_input_required"]);
const blockedStates = new Set(["blocked", "failed", "quarantined", "unreachable"]);
const reviewStates = new Set(["degraded", "stalled", "retrying"]);

export function businessAttention(context: BusinessContext): AttentionItem[] {
  const sections: BusinessSection[] = ["decisions", "objectives", "jobs", "integrations"];
  const matches: AttentionItem[] = [];
  for (const section of sections) {
    for (const record of context.sections[section].records) {
      const state = record.status.toLowerCase();
      const kind: AttentionKind | null = section === "decisions" && approvalStates.has(state)
        ? "approval"
        : ownerInputStates.has(state) ? "owner_input"
          : blockedStates.has(state) ? "blocked"
            : reviewStates.has(state) ? "review"
              : null;
      if (kind) matches.push({
        id: `${section}:${record.id}`,
        title: record.title,
        section,
        status: record.status,
        kind
      });
    }
  }
  const rank: Record<AttentionKind, number> = { approval: 0, owner_input: 1, blocked: 2, review: 3 };
  return matches.sort((a, b) => rank[a.kind] - rank[b.kind] || a.id.localeCompare(b.id));
}
