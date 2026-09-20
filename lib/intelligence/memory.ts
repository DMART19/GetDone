import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { ContextItem } from "@/lib/intelligence/context";

export type OperationalMemoryKind =
  | "fact"
  | "lesson"
  | "experiment"
  | "observation"
  | "outcome-reference";

export type OperationalMemorySensitivity =
  | "public"
  | "internal"
  | "customer"
  | "sensitive";

interface OperationalMemoryBase {
  id: string;
  kind: OperationalMemoryKind;
  portfolioId: string;
  companyId: string;
  confidence: number;
  sampleSize?: number;
  confounders: readonly string[];
  evidenceIds: readonly string[];
  relevanceTags: readonly string[];
  observedAt: string;
  expiresAt?: string;
  supersedesId?: string;
  sensitivity: OperationalMemorySensitivity;
  authority: "advisory";
  recordHash: string;
}

export interface FactMemory extends OperationalMemoryBase {
  kind: "fact";
  statement: string;
}

export interface LessonMemory extends OperationalMemoryBase {
  kind: "lesson";
  lesson: string;
  applicability: string;
}

export interface ExperimentMemory extends OperationalMemoryBase {
  kind: "experiment";
  hypothesis: string;
  status: "planned" | "running" | "completed" | "cancelled";
  resultSummary?: string;
}

export interface ObservationMemory extends OperationalMemoryBase {
  kind: "observation";
  observation: string;
}

export interface OutcomeReferenceMemory extends OperationalMemoryBase {
  kind: "outcome-reference";
  outcomeId: string;
  metric: string;
  value: string | number | boolean;
}

export type OperationalMemoryRecord =
  | FactMemory
  | LessonMemory
  | ExperimentMemory
  | ObservationMemory
  | OutcomeReferenceMemory;

type MemoryDraft<T extends OperationalMemoryRecord> =
  Omit<T, "authority" | "recordHash">;

export type OperationalMemoryDraft =
  | MemoryDraft<FactMemory>
  | MemoryDraft<LessonMemory>
  | MemoryDraft<ExperimentMemory>
  | MemoryDraft<ObservationMemory>
  | MemoryDraft<OutcomeReferenceMemory>;

export interface OperationalMemoryScope {
  portfolioId: string;
  companyId: string;
}

export interface MemorySelectionQuery {
  tags?: readonly string[];
  textTerms?: readonly string[];
  minConfidence?: number;
  maxItems?: number;
  now?: number;
}

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", label + " must be a valid timestamp");
  }
  return parsed;
}

function uniqueSorted(values: readonly string[]) {
  return Object.freeze([...new Set(values.map((item) => item.trim()).filter(Boolean))].sort());
}

function memoryText(record: OperationalMemoryRecord) {
  switch (record.kind) {
    case "fact":
      return record.statement;
    case "lesson":
      return record.lesson + " Applicability: " + record.applicability;
    case "experiment":
      return record.hypothesis + (record.resultSummary ? " Result: " + record.resultSummary : "");
    case "observation":
      return record.observation;
    case "outcome-reference":
      return record.metric + ": " + String(record.value) + " (outcome " + record.outcomeId + ")";
  }
}

export function createOperationalMemory(
  input: OperationalMemoryDraft
): OperationalMemoryRecord {
  if (!input.portfolioId || !input.companyId || !input.id) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Operational memory requires portfolio, company, and record identity"
    );
  }

  const observedAt = parseTime(input.observedAt, "Memory observedAt");
  if (input.expiresAt && parseTime(input.expiresAt, "Memory expiresAt") <= observedAt) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Operational memory expiry must be after observation"
    );
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Operational memory confidence must be between 0 and 1"
    );
  }
  if (
    input.sampleSize !== undefined
    && (!Number.isInteger(input.sampleSize) || input.sampleSize < 0)
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Operational memory sample size must be a non-negative integer"
    );
  }

  const base = {
    ...input,
    confounders: uniqueSorted(input.confounders),
    evidenceIds: uniqueSorted(input.evidenceIds),
    relevanceTags: uniqueSorted(input.relevanceTags),
    authority: "advisory" as const
  };

  const record = {
    ...base,
    recordHash: sha256Hex(base)
  } as OperationalMemoryRecord;

  return Object.freeze(record);
}

export function assertOperationalMemoryIntegrity(record: OperationalMemoryRecord) {
  const { recordHash, ...base } = record;
  if (record.authority !== "advisory" || sha256Hex(base) !== recordHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Operational memory integrity or authority classification is invalid"
    );
  }
}

export function isOperationalMemoryActive(
  record: OperationalMemoryRecord,
  now = Date.now()
) {
  assertOperationalMemoryIntegrity(record);
  const observedAt = Date.parse(record.observedAt);
  const expiresAt = record.expiresAt ? Date.parse(record.expiresAt) : Infinity;
  return observedAt <= now && expiresAt > now;
}

function relevanceScore(
  record: OperationalMemoryRecord,
  query: MemorySelectionQuery,
  now: number
) {
  const tags = new Set((query.tags ?? []).map((tag) => tag.toLowerCase()));
  const recordTags = record.relevanceTags.map((tag) => tag.toLowerCase());
  const tagMatches = recordTags.filter((tag) => tags.has(tag)).length;

  const text = memoryText(record).toLowerCase();
  const textMatches = (query.textTerms ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean)
    .filter((term) => text.includes(term)).length;

  const ageHours = Math.max(0, now - Date.parse(record.observedAt)) / 3_600_000;
  const recency = 1 / (1 + ageHours);
  const sampleWeight = Math.min(record.sampleSize ?? 0, 1000) / 1000;

  return (
    tagMatches * 10
    + textMatches * 5
    + record.confidence * 2
    + sampleWeight
    + recency
  );
}

export function selectOperationalMemory(
  records: readonly OperationalMemoryRecord[],
  scope: OperationalMemoryScope,
  query: MemorySelectionQuery = {}
) {
  const now = query.now ?? Date.now();
  const minConfidence = query.minConfidence ?? 0;
  const maxItems = Math.max(0, query.maxItems ?? 12);

  const scoped = records.filter((record) => {
    assertOperationalMemoryIntegrity(record);
    return (
      record.portfolioId === scope.portfolioId
      && record.companyId === scope.companyId
      && record.confidence >= minConfidence
      && isOperationalMemoryActive(record, now)
    );
  });

  const supersededIds = new Set(
    scoped.map((record) => record.supersedesId).filter((id): id is string => Boolean(id))
  );

  return Object.freeze(
    scoped
      .filter((record) => !supersededIds.has(record.id))
      .map((record) => ({
        record,
        score: relevanceScore(record, query, now)
      }))
      .sort((left, right) =>
        right.score - left.score
        || Date.parse(right.record.observedAt) - Date.parse(left.record.observedAt)
        || left.record.id.localeCompare(right.record.id)
      )
      .slice(0, maxItems)
      .map(({ record }) => record)
  );
}

export function operationalMemoryToContextItems(
  records: readonly OperationalMemoryRecord[],
  defaultFreshnessSeconds = 86_400
): readonly ContextItem[] {
  return Object.freeze(records.map((record) => {
    assertOperationalMemoryIntegrity(record);
    const observedAt = Date.parse(record.observedAt);
    const expiresAt = record.expiresAt ? Date.parse(record.expiresAt) : undefined;
    const freshnessSeconds = expiresAt
      ? Math.max(0, Math.floor((expiresAt - observedAt) / 1000))
      : defaultFreshnessSeconds;

    return Object.freeze({
      id: "memory:" + record.id,
      kind: "memory" as const,
      portfolioId: record.portfolioId,
      companyId: record.companyId,
      source: "operational-memory",
      provenance: "memory:" + record.id + ":" + record.recordHash,
      observedAt: record.observedAt,
      freshnessSeconds,
      sensitivity: record.sensitivity,
      content: memoryText(record)
    });
  }));
}
