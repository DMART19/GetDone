import type { BusinessContext } from "./contracts";
import { businessAttention, type AttentionKind } from "./attention-summary";

export interface PortfolioAttentionItem {
  id: string;
  businessId: string;
  portfolioId: string;
  businessName: string;
  section: BusinessContext["sections"] extends Record<infer K, unknown> ? K : never;
  recordId: string;
  title: string;
  status: string;
  kind: AttentionKind;
}
export interface PortfolioAttentionOverview {
  items: readonly PortfolioAttentionItem[];
  inspectedBusinesses: number;
  incomplete: boolean;
  note: string;
}
const priority: Record<AttentionKind, number> = { approval: 0, owner_input: 1, blocked: 2, review: 3 };

/** Read-only portfolio summary. This is advisory, not a cross-tenant authority path. */
export function portfolioAttentionOverview(
  contexts: readonly BusinessContext[],
  options: { totalBusinesses: number; maxItems?: number } 
): PortfolioAttentionOverview {
  const cap = Math.max(0, Math.min(40, Math.trunc(options.maxItems ?? 20)));
  const seen = new Set<string>();
  const items: PortfolioAttentionItem[] = [];
  for (const context of contexts) {
    const business = context.business;
    for (const item of businessAttention(context)) {
      const id = [business.portfolioId, business.id, item.section, item.id].join(":");
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({
        id, businessId: business.id, portfolioId: business.portfolioId,
        businessName: business.name, section: item.section,
        recordId: item.id.slice(item.section.length + 1),
        title: item.title, status: item.status, kind: item.kind
      });
    }
  }
  items.sort((a, b) => priority[a.kind] - priority[b.kind]
    || a.businessName.localeCompare(b.businessName) || a.id.localeCompare(b.id));
  const incomplete = contexts.length < options.totalBusinesses || items.length > cap;
  return Object.freeze({
    items: Object.freeze(items.slice(0, cap)),
    inspectedBusinesses: contexts.length,
    incomplete,
    note: "Based on up to 20 recent records per business category; not proof of live connector health or a complete portfolio-wide inbox."
  });
}
