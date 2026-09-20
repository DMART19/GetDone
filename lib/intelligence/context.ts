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
}

export function assembleContext(
  candidates: readonly ContextItem[],
  scope: ContextScope,
  maxItems = 30
): AssembledContext {
  const eligible = candidates
    .filter((item) => item.portfolioId === scope.portfolioId)
    .filter((item) => !scope.companyId || item.companyId === scope.companyId)
    .filter((item) => scope.allowedSensitivity.includes(item.sensitivity))
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));

  return {
    scope,
    items: eligible.slice(0, Math.max(0, maxItems)),
    truncated: eligible.length > maxItems
  };
}
