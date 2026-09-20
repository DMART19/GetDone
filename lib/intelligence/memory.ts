import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { ContextItem } from "@/lib/intelligence/context";

export type MemorySensitivity = "public" | "internal" | "customer" | "sensitive";

export interface OperationalMemoryBase {
  id: string;
  portfolioId: string;
  companyId: string;
  authority: "advisory";
  sensitivity: MemorySensitivity;
  source: string;
  provenance: string;
  observedAt: string;
  expiresAt?: string;
  supersedesId?: string;
  supersededById?: string;
  evidenceIds: readonly string[];
  confidence: number;
  sampleSize: number;
  confounders: readonly string[];
  tags: readonly string[];
}

export interface Fact extends OperationalMemoryBase {
  kind: "fact";
  statement: string;
}

export interface Lesson extends OperationalMemoryBase {
  kind: "lesson";
  lesson: string;
  recommendedAction?: string;
}

export interface Experiment extends OperationalMemoryBase {
  kind: "experiment";
  hypothesis: string;
  treatment: string;
  result: string;
}

export interface Observation extends OperationalMemoryBase {
  kind: "observation";
  observation: string;
}

export interface OutcomeReference extends OperationalMemoryBase {
  kind: "outcome-reference";
  outcomeId: string;
  summary: string;
}

export type OperationalMemoryRecord =
  | Fact
  | Lesson
  | Experiment
  | Observation
  | OutcomeReference;

export interface MemoryScope {
  portfolioId: string;
  companyId: string;
}

export interface MemorySelectionOptions {
  now?: number;
  limit?: number;
  minConfidence?: number;
  queryTags?: readonly string[];
}

function parsedTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

function recordText(record: OperationalMemoryRecord) {
  switch (record.kind) {
    case "fact":
      return record.statement;
    case "lesson":
      return record.recommendedAction
        ? `${record.lesson} Suggested action: ${record.recommendedAction}`
        : record.lesson;
    case "experiment":
      return `Hypothesis: ${record.hypothesis}. Treatment: ${record.treatment}. Result: ${record.result}`;
    case "observation":
      return record.observation;
    case "outcome-reference":
      return `Outcome ${record.outcomeId}: ${record.summary}`;
  }
}

export function validateOperationalMemory(record: OperationalMemoryRecord) {
  if (
    !record.id
    || !record.portfolioId
    || !record.companyId
    || record.authority !== "advisory"
    || !record.source
    || !record.provenance
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Operational memory requires scoped identity, provenance, and advisory authority"
    );
  }
  if (record.confidence < 0 || record.confidence > 1 || !Number.isFinite(record.confidence)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Memory confidence must be between 0 and 1");
  }
  if (!Number.isInteger(record.sampleSize) || record.sampleSize < 1) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Memory sample size must be a positive integer");
  }

  const observedAt = parsedTime(record.observedAt, "observedAt");
  if (record.expiresAt && parsedTime(record.expiresAt, "expiresAt") <= observedAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Memory expiry must be after observation");
  }
  if (!recordText(record).trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Operational memory content cannot be empty");
  }
  return record;
}

export function memoryRelevanceScore(
  record: OperationalMemoryRecord,
  queryTags: readonly string[] = []
) {
  const wanted = new Set(queryTags.map((tag) => tag.toLowerCase()));
  const tagMatches = record.tags.reduce(
    (count, tag) => count + (wanted.has(tag.toLowerCase()) ? 1 : 0),
    0
  );
  const evidenceWeight = Math.min(record.evidenceIds.length, 5) * 0.05;
  const sampleWeight = Math.min(Math.log10(record.sampleSize + 1), 2) * 0.1;
  return tagMatches * 10 + record.confidence + evidenceWeight + sampleWeight;
}

export function selectOperationalMemory(
  records: readonly OperationalMemoryRecord[],
  scope: MemoryScope,
  options: MemorySelectionOptions = {}
) {
  const now = options.now ?? Date.now();
  const minConfidence = options.minConfidence ?? 0;
  const limit = Math.max(0, options.limit ?? 20);

  return records
    .filter((record) => {
      validateOperationalMemory(record);
      if (record.portfolioId !== scope.portfolioId || record.companyId !== scope.companyId) {
        return false;
      }
      if (record.supersededById) return false;
      if (record.confidence < minConfidence) return false;
      if (parsedTime(record.observedAt, "observedAt") > now) return false;
      if (record.expiresAt && parsedTime(record.expiresAt, "expiresAt") <= now) return false;
      return true;
    })
    .sort((left, right) => {
      const score =
        memoryRelevanceScore(right, options.queryTags)
        - memoryRelevanceScore(left, options.queryTags);
      if (score !== 0) return score;
      return Date.parse(right.observedAt) - Date.parse(left.observedAt);
    })
    .slice(0, limit);
}

export function operationalMemoryToContextItem(
  record: OperationalMemoryRecord,
  now = Date.now()
): ContextItem {
  validateOperationalMemory(record);
  const observedAt = parsedTime(record.observedAt, "observedAt");
  const expiry = record.expiresAt ? parsedTime(record.expiresAt, "expiresAt") : now + 86_400_000;
  const freshnessSeconds = Math.max(0, Math.floor((expiry - observedAt) / 1000));

  return {
    id: `memory:${record.id}`,
    kind: "memory",
    portfolioId: record.portfolioId,
    companyId: record.companyId,
    source: record.source,
    provenance: record.provenance,
    observedAt: record.observedAt,
    freshnessSeconds,
    sensitivity: record.sensitivity,
    content: recordText(record)
  };
}
