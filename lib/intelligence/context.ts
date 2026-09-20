export type ContextKind =
  | "fact"
  | "signal"
  | "outcome"
  | "decision"
  | "policy"
  | "capability"
  | "resource-summary";

export interface ContextItem {
  id: string;
  kind: ContextKind;
  portfolioId: string;
  companyId?: string;
  source: string;
  observedAt: string;
  freshnessSeconds: number;
  sensitivity: "public" | "internal" | "customer" | "sensitive";
  content: string;
}

export interface ContextScope {
  portfolioId: string;
  companyId?: string;
  allowedSensitivity: readonly ContextItem["sensitivity"][];
}

export interface AssembledContext {
  scope: ContextScope;
  items: readonly ContextItem[];
  truncated: boolean;
  characterCount: number;
}

export function assembleContext(
  candidates: readonly ContextItem[],
  scope: ContextScope,
  maxItems = 30,
  maxCharacters = 24_000
): AssembledContext {
  const eligible = candidates
    .filter((item) => item.portfolioId === scope.portfolioId)
    .filter((item) => !scope.companyId || item.companyId === scope.companyId)
    .filter((item) => scope.allowedSensitivity.includes(item.sensitivity))
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));

  const items: ContextItem[] = [];
  let characterCount = 0;

  for (const item of eligible) {
    if (items.length >= Math.max(0, maxItems)) break;
    if (characterCount + item.content.length > Math.max(0, maxCharacters)) break;
    items.push(item);
    characterCount += item.content.length;
  }

  return {
    scope,
    items,
    truncated: items.length < eligible.length,
    characterCount
  };
}
