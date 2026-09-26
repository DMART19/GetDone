import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  AnalyticsEvidenceRecord,
  AnalyticsIngestionCheckpoint,
  AnalyticsIngestionEvidenceStore,
  AnalyticsIngestionResult,
  AnalyticsIngestionRun
} from "@/lib/analytics/ingestion";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

type Scope=Pick<TrustedExecutionScope,"portfolioId"|"companyId"|"environment">;

interface CheckpointRow {
  portfolio_id:string;
  company_id:string;
  environment:Scope["environment"];
  source_id:string;
  cursor_value:string|null;
  version:number;
  checkpoint_hash:string;
  updated_at:Date|string;
  payload:AnalyticsIngestionCheckpoint;
}

interface RunRow {
  request_id:string;
  input_hash:string;
  result_hash:string;
  observed_at:Date|string;
  payload:AnalyticsIngestionResult;
}

function iso(value:Date|string){return value instanceof Date ? value.toISOString() : String(value);}

export class PostgresAnalyticsIngestionStore implements AnalyticsIngestionEvidenceStore {
  constructor(private readonly db:PostgresTransactionalDatabase){}

  async getCheckpoint(scope:Scope,sourceId:string){
    const result=await this.db.query<CheckpointRow>(
      `SELECT portfolio_id,company_id,environment,source_id,cursor_value,version,
              checkpoint_hash,updated_at,payload
       FROM analytics_ingestion_checkpoints
       WHERE portfolio_id=$1 AND company_id=$2 AND environment=$3 AND source_id=$4`,
      [scope.portfolioId,scope.companyId,scope.environment,sourceId]
    );
    const row=result.rows[0];
    if(!row) return null;
    return {
      ...row.payload,
      cursor:row.cursor_value ?? undefined,
      version:row.version,
      updatedAt:iso(row.updated_at),
      checkpointHash:row.checkpoint_hash
    };
  }

  async getRun(scope:Scope,sourceId:string,requestId:string){
    const result=await this.db.query<RunRow>(
      `SELECT request_id,input_hash,result_hash,observed_at,payload
       FROM analytics_ingestion_runs
       WHERE portfolio_id=$1 AND company_id=$2 AND environment=$3
         AND source_id=$4 AND request_id=$5`,
      [scope.portfolioId,scope.companyId,scope.environment,sourceId,requestId]
    );
    const row=result.rows[0];
    if(!row) return null;
    return {
      requestId:row.request_id,
      inputHash:row.input_hash,
      result:row.payload,
      resultHash:row.result_hash,
      observedAt:iso(row.observed_at)
    } satisfies AnalyticsIngestionRun;
  }

  async commitPage(input:{
    requestId:string;
    inputHash:string;
    scope:Scope;
    sourceId:string;
    expectedCheckpointHash?:string;
    fromCursor?:string;
    result:AnalyticsIngestionResult;
  }){
    return this.db.transaction(async(db)=>{
      const existingRun=await db.query<RunRow>(
        `SELECT request_id,input_hash,result_hash,observed_at,payload
         FROM analytics_ingestion_runs
         WHERE portfolio_id=$1 AND company_id=$2 AND environment=$3
           AND source_id=$4 AND request_id=$5
         FOR UPDATE`,
        [
          input.scope.portfolioId,input.scope.companyId,input.scope.environment,
          input.sourceId,input.requestId
        ]
      );
      if(existingRun.rows[0]){
        const row=existingRun.rows[0];
        if(row.input_hash!==input.inputHash){
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Analytics ingestion request ID was reused with a different input"
          );
        }
        const checkpoint=await db.query<CheckpointRow>(
          `SELECT portfolio_id,company_id,environment,source_id,cursor_value,version,
                  checkpoint_hash,updated_at,payload
           FROM analytics_ingestion_checkpoints
           WHERE portfolio_id=$1 AND company_id=$2 AND environment=$3 AND source_id=$4`,
          [
            input.scope.portfolioId,input.scope.companyId,
            input.scope.environment,input.sourceId
          ]
        );
        const cp=checkpoint.rows[0];
        if(!cp) throw new ControlPlaneError("UNAVAILABLE","Analytics checkpoint disappeared after committed run");
        return {
          insertedEvidence:0,
          checkpoint:{
            ...cp.payload,
            cursor:cp.cursor_value ?? undefined,
            version:cp.version,
            updatedAt:iso(cp.updated_at),
            checkpointHash:cp.checkpoint_hash
          },
          run:{
            requestId:row.request_id,
            inputHash:row.input_hash,
            result:row.payload,
            resultHash:row.result_hash,
            observedAt:iso(row.observed_at)
          }
        };
      }

      const current=await db.query<CheckpointRow>(
        `SELECT portfolio_id,company_id,environment,source_id,cursor_value,version,
                checkpoint_hash,updated_at,payload
         FROM analytics_ingestion_checkpoints
         WHERE portfolio_id=$1 AND company_id=$2 AND environment=$3 AND source_id=$4
         FOR UPDATE`,
        [
          input.scope.portfolioId,input.scope.companyId,
          input.scope.environment,input.sourceId
        ]
      );
      const row=current.rows[0];
      const currentCursor=row?.cursor_value ?? undefined;
      if((row?.checkpoint_hash ?? undefined)!==input.expectedCheckpointHash || currentCursor!==input.fromCursor){
        throw new ControlPlaneError(
          "CONFLICT",
          "Analytics checkpoint advanced before page persistence"
        );
      }

      let insertedEvidence=0;
      for(const evidence of input.result.records){
        const inserted=await db.query(
          `INSERT INTO analytics_ingestion_evidence
            (evidence_hash,portfolio_id,company_id,environment,source_id,external_id,
             dedupe_key,source_updated_at,observed_at,fresh,provenance_hash,payload,provenance)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
           ON CONFLICT(portfolio_id,company_id,environment,source_id,dedupe_key) DO NOTHING`,
          [
            evidence.evidenceHash,
            input.scope.portfolioId,
            input.scope.companyId,
            input.scope.environment,
            input.sourceId,
            evidence.externalId,
            evidence.dedupeKey,
            evidence.sourceUpdatedAt,
            evidence.observedAt,
            evidence.fresh,
            sha256Hex(evidence.provenance),
            JSON.stringify(evidence.payload),
            JSON.stringify(evidence.provenance)
          ]
        );
        insertedEvidence += inserted.rowCount ?? 0;
      }

      const version=(row?.version ?? 0)+1;
      const checkpointBase={
        scope:input.scope,
        sourceId:input.sourceId,
        cursor:input.result.nextCursor,
        version,
        updatedAt:input.result.observedAt
      };
      const checkpoint:AnalyticsIngestionCheckpoint={
        ...checkpointBase,
        checkpointHash:sha256Hex(checkpointBase)
      };
      await db.query(
        `INSERT INTO analytics_ingestion_checkpoints
          (portfolio_id,company_id,environment,source_id,cursor_value,version,
           checkpoint_hash,updated_at,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT(portfolio_id,company_id,environment,source_id) DO UPDATE
         SET cursor_value=excluded.cursor_value,version=excluded.version,
             checkpoint_hash=excluded.checkpoint_hash,updated_at=excluded.updated_at,
             payload=excluded.payload`,
        [
          input.scope.portfolioId,input.scope.companyId,input.scope.environment,
          input.sourceId,input.result.nextCursor ?? null,version,
          checkpoint.checkpointHash,input.result.observedAt,JSON.stringify(checkpoint)
        ]
      );

      const runBase={
        requestId:input.requestId,
        inputHash:input.inputHash,
        result:input.result,
        observedAt:input.result.observedAt
      };
      const run:AnalyticsIngestionRun={
        ...runBase,
        resultHash:sha256Hex(input.result)
      };
      await db.query(
        `INSERT INTO analytics_ingestion_runs
          (request_id,portfolio_id,company_id,environment,source_id,input_hash,
           result_hash,observed_at,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          input.requestId,input.scope.portfolioId,input.scope.companyId,
          input.scope.environment,input.sourceId,input.inputHash,
          run.resultHash,input.result.observedAt,JSON.stringify(input.result)
        ]
      );

      return {insertedEvidence,checkpoint,run};
    });
  }
}
