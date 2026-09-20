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
  resourceId?: string;
  source: string;
  provenance: string;
  observedAt: string;
  freshnessSeconds: number;
  sensitivity: "public" | "internal" | "customer" | "sensitive";
  content: string;
}

export interface ContextScope {
  portfolioId: string;
  companyId?: string;
  allowedResourceIds?: readonly string[];
  allowedSensitivity: readonly ContextItem["sensitivity"][];
}

export interface ContextSection {
  kind: ContextKind;
  items: readonly ContextItem[];
  characterCount: number;
}

export interface AssembledContext {
  scope: ContextScope;
  sections: {
    facts: ContextSection;
    signals: ContextSection;
    outcomes: ContextSection;
    decisions: ContextSection;
    policies: ContextSection;
    capabilities: ContextSection;
    resourceSummaries: ContextSection;
  };
  items: readonly ContextItem[];
  truncated: boolean;
  characterCount: number;
  excluded: {
    stale: number;
    unauthorizedScope: number;
    sensitivity: number;
    resourceScope: number;
    size: number;
  };
}

export interface ContextAssemblyOptions {
  now?: number;
  maxItems?: number;
  maxCharacters?: number;
  maxItemsPerSection?: Partial<Record<ContextKind, number>>;
}

const sectionName: Record<ContextKind, keyof AssembledContext["sections"]> = {
  fact: "facts",
  signal: "signals",
  outcome: "outcomes",
  decision: "decisions",
  policy: "policies",
  capability: "capabilities",
  "resource-summary": "resourceSummaries"
};

function emptySection(kind: ContextKind): ContextSection {
  return { kind, items: [], characterCount: 0 };
}

export function isContextItemFresh(item: ContextItem, now = Date.now()) {
  const observedAt = Date.parse(item.observedAt);
  if (!Number.isFinite(observedAt) || item.freshnessSeconds < 0) return false;
  return observedAt <= now && now - observedAt <= item.freshnessSeconds * 1000;
}

function scopeEligible(item: ContextItem, scope: ContextScope) {
  if (item.portfolioId !== scope.portfolioId) return false;
  if (scope.companyId) return item.companyId === scope.companyId;
  return true;
}

function resourceEligible(item: ContextItem, scope: ContextScope) {
  if (item.kind !== "resource-summary") return true;
  if (!item.resourceId) return false;
  return Boolean(scope.allowedResourceIds?.includes(item.resourceId));
}

export function assembleContext(
  candidates: readonly ContextItem[],
  scope: ContextScope,
  options: ContextAssemblyOptions = {}
): AssembledContext {
  const now = options.now ?? Date.now();
  const maxItems = Math.max(0, options.maxItems ?? 30);
  const maxCharacters = Math.max(0, options.maxCharacters ?? 24_000);
  const perSection = options.maxItemsPerSection ?? {};

  const excluded = {
    stale: 0,
    unauthorizedScope: 0,
    sensitivity: 0,
    resourceScope: 0,
    size: 0
  };

  const eligible: ContextItem[] = [];
  for (const item of candidates) {
    if (!scopeEligible(item, scope)) {
      excluded.unauthorizedScope += 1;
      continue;
    }
    if (!scope.allowedSensitivity.includes(item.sensitivity)) {
      excluded.sensitivity += 1;
      continue;
    }
    if (!resourceEligible(item, scope)) {
      excluded.resourceScope += 1;
      continue;
    }
    if (!isContextItemFresh(item, now)) {
      excluded.stale += 1;
      continue;
    }
    eligible.push(item);
  }

  eligible.sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));

  const sectionItems: Record<keyof AssembledContext["sections"], ContextItem[]> = {
    facts: [],
    signals: [],
    outcomes: [],
    decisions: [],
    policies: [],
    capabilities: [],
    resourceSummaries: []
  };

  const items: ContextItem[] = [];
  let characterCount = 0;

  for (const item of eligible) {
    const target = sectionName[item.kind];
    const sectionLimit = Math.max(0, perSection[item.kind] ?? maxItems);

    if (items.length >= maxItems || sectionItems[target].length >= sectionLimit) {
      excluded.size += 1;
      continue;
    }
    if (characterCount + item.content.length > maxCharacters) {
      excluded.size += 1;
      continue;
    }

    sectionItems[target].push(item);
    items.push(item);
    characterCount += item.content.length;
  }

  const sections: AssembledContext["sections"] = {
    facts: { ...emptySection("fact"), items: sectionItems.facts, characterCount: sectionItems.facts.reduce((total, item) => total + item.content.length, 0) },
    signals: { ...emptySection("signal"), items: sectionItems.signals, characterCount: sectionItems.signals.reduce((total, item) => total + item.content.length, 0) },
    outcomes: { ...emptySection("outcome"), items: sectionItems.outcomes, characterCount: sectionItems.outcomes.reduce((total, item) => total + item.content.length, 0) },
    decisions: { ...emptySection("decision"), items: sectionItems.decisions, characterCount: sectionItems.decisions.reduce((total, item) => total + item.content.length, 0) },
    policies: { ...emptySection("policy"), items: sectionItems.policies, characterCount: sectionItems.policies.reduce((total, item) => total + item.content.length, 0) },
    capabilities: { ...emptySection("capability"), items: sectionItems.capabilities, characterCount: sectionItems.capabilities.reduce((total, item) => total + item.content.length, 0) },
    resourceSummaries: { ...emptySection("resource-summary"), items: sectionItems.resourceSummaries, characterCount: sectionItems.resourceSummaries.reduce((total, item) => total + item.content.length, 0) }
  };

  return {
    scope,
    sections,
    items,
    truncated: Object.values(excluded).some((count) => count > 0),
    characterCount,
    excluded
  };
}
