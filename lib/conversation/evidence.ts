import { topicFor } from "./understanding";
import type { ContextItem } from "@/lib/intelligence/context";
const terms = {
  revenue: /revenue|financial|sales|invoice|billing|mrr|payment|profit/i,
  deployment: /deploy|infrastructure|release|error|server|build|uptime/i,
  marketing: /marketing|campaign|landing|positioning|acquisition|advertis|conversion/i,
  customers: /customer|support|crm|feedback|usage|retention/i
};
export function relevance(item: ContextItem, question?: string) {
  const topic = topicFor(question ?? "");
  if (!topic || topic === "health") return 0;
  return terms[topic].test(`${item.source} ${item.content}`) ? 10 : 0;
}
export function missingEvidence(topic?: string | null) {
  switch (topic) {
    case "revenue": return "I don't have current financial or sales evidence to explain revenue. Connect a billing/accounting source or CRM, or provide dated revenue and sales records.";
    case "deployment": return "I don't have current deployment evidence. Connect the hosting provider or repository and supply deployment results and error logs.";
    case "marketing": return "I don't have current marketing evidence. Connect campaign or acquisition analytics, or provide landing-page, positioning and campaign results.";
    case "customers": return "I don't have current customer evidence. Connect support, CRM or product analytics, or provide dated feedback and usage records.";
    default: return "I don't have current authoritative business evidence. Connect the business's integrations or provide dated operating records.";
  }
}
