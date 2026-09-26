import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export const ANALYTICS_INGESTION_CONTRACT_VERSION = "1.0.0";

export interface AnalyticsProvenance {
  sourceId:string;
  sourceUrlHash:string;
  cursorHash?:string;
  providerBatchHash:string;
}

export interface AnalyticsEvidenceRecord {
  externalId:string;
  sourceUpdatedAt:string;
  observedAt:string;
  fresh:boolean;
  dedupeKey:string;
  payloadHash:string;
  payload:Record<string,unknown>;
  provenance:AnalyticsProvenance;
  evidenceHash:string;
}

export interface AnalyticsIngestionCheckpoint {
  scope:Pick<TrustedExecutionScope,"portfolioId"|"companyId"|"environment">;
  sourceId:string;
  cursor?:string;
  version:number;
  updatedAt:string;
  checkpointHash:string;
}

export interface AnalyticsIngestionResult {
  sourceId:string;
  checkpointBefore?:string;
  nextCursor?:string;
  records:readonly AnalyticsEvidenceRecord[];
  batchHash:string;
  observedAt:string;
}

export interface AnalyticsIngestionRun {
  requestId:string;
  inputHash:string;
  result:AnalyticsIngestionResult;
  resultHash:string;
  observedAt:string;
}

export interface AnalyticsIngestionEvidenceStore {
  getCheckpoint(
    scope:Pick<TrustedExecutionScope,"portfolioId"|"companyId"|"environment">,
    sourceId:string
  ):Promise<AnalyticsIngestionCheckpoint|null>;
  getRun(
    scope:Pick<TrustedExecutionScope,"portfolioId"|"companyId"|"environment">,
    sourceId:string,
    requestId:string
  ):Promise<AnalyticsIngestionRun|null>;
  commitPage(input:{
    requestId:string;
    inputHash:string;
    scope:Pick<TrustedExecutionScope,"portfolioId"|"companyId"|"environment">;
    sourceId:string;
    expectedCheckpointHash?:string;
    fromCursor?:string;
    result:AnalyticsIngestionResult;
  }):Promise<{insertedEvidence:number;checkpoint:AnalyticsIngestionCheckpoint;run:AnalyticsIngestionRun}>;
}

export function createAnalyticsEvidenceRecord(input:{
  scope:Pick<TrustedExecutionScope,"portfolioId"|"companyId"|"environment">;
  sourceId:string;
  sourceUrlHash:string;
  cursor?:string;
  providerBatchHash:string;
  externalId:string;
  sourceUpdatedAt:string;
  observedAt:string;
  fresh:boolean;
  payload:Record<string,unknown>;
}):AnalyticsEvidenceRecord{
  const payloadHash=sha256Hex(input.payload);
  const dedupeKey=sha256Hex({
    sourceId:input.sourceId,
    externalId:input.externalId,
    sourceUpdatedAt:input.sourceUpdatedAt,
    payloadHash
  });
  const provenance:AnalyticsProvenance={
    sourceId:input.sourceId,
    sourceUrlHash:input.sourceUrlHash,
    cursorHash:input.cursor ? sha256Hex(input.cursor) : undefined,
    providerBatchHash:input.providerBatchHash
  };
  const base={
    externalId:input.externalId,
    sourceUpdatedAt:input.sourceUpdatedAt,
    observedAt:input.observedAt,
    fresh:input.fresh,
    dedupeKey,
    payloadHash,
    payload:input.payload,
    provenance
  };
  return Object.freeze({
    ...base,
    evidenceHash:sha256Hex({
      scope:input.scope,
      sourceId:input.sourceId,
      dedupeKey,
      payloadHash,
      provenance
    })
  });
}
