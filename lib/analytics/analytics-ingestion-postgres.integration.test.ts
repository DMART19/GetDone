import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAnalyticsEvidenceRecord } from "@/lib/analytics/ingestion";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { PostgresAnalyticsIngestionStore } from "@/lib/persistence/postgres/analytics-ingestion-store";
import { PostgresDatabase, readPostgresConfigFromEnv } from "@/lib/persistence/postgres/client";

const enabled=process.env.GETDONE_POSTGRES_INTEGRATION==="true";
const suite=enabled?describe.sequential:describe.skip;

suite("PostgreSQL analytics ingestion persistence",()=>{
  let database:PostgresDatabase|undefined;
  const scope={
    portfolioId:"portfolio-analytics-integration",
    companyId:"company-analytics-integration",
    environment:"staging" as const
  };
  const sourceId="analytics-source-integration";

  function db(){
    if(!database) throw new Error("analytics integration database not initialized");
    return database;
  }

  beforeAll(async()=>{
    database=new PostgresDatabase(readPostgresConfigFromEnv(process.env));
    await db().query(
      "DELETE FROM analytics_ingestion_runs WHERE company_id=$1",
      [scope.companyId]
    );
    await db().query(
      "DELETE FROM analytics_ingestion_evidence WHERE company_id=$1",
      [scope.companyId]
    );
    await db().query(
      "DELETE FROM analytics_ingestion_checkpoints WHERE company_id=$1",
      [scope.companyId]
    );
  });

  afterAll(async()=>{
    if(!database) return;
    await database.query("DELETE FROM analytics_ingestion_runs WHERE company_id=$1",[scope.companyId]);
    await database.query("DELETE FROM analytics_ingestion_evidence WHERE company_id=$1",[scope.companyId]);
    await database.query("DELETE FROM analytics_ingestion_checkpoints WHERE company_id=$1",[scope.companyId]);
    await database.close();
  });

  function evidence(externalId:string,metric:number){
    return createAnalyticsEvidenceRecord({
      scope,
      sourceId,
      sourceUrlHash:"1".repeat(64),
      providerBatchHash:"2".repeat(64),
      externalId,
      sourceUpdatedAt:"2026-09-25T20:00:00.000Z",
      observedAt:"2026-09-25T20:01:00.000Z",
      fresh:true,
      payload:{id:externalId,metric}
    });
  }

  it("persists evidence, advances checkpoints atomically, deduplicates rows, and replays requests idempotently",async()=>{
    const store=new PostgresAnalyticsIngestionStore(db());
    const firstRecord=evidence("event-1",10);
    const firstResult={
      sourceId,
      nextCursor:"cursor-2",
      records:[firstRecord],
      batchHash:sha256Hex({page:1}),
      observedAt:"2026-09-25T20:01:00.000Z"
    };
    const first=await store.commitPage({
      requestId:"analytics-run-1",
      inputHash:"3".repeat(64),
      scope,
      sourceId,
      result:firstResult
    });
    expect(first.insertedEvidence).toBe(1);
    expect(first.checkpoint).toMatchObject({cursor:"cursor-2",version:1});
    expect(await store.getRun(scope,sourceId,"analytics-run-1")).toMatchObject({
      inputHash:"3".repeat(64),
      result:firstResult
    });

    const replay=await store.commitPage({
      requestId:"analytics-run-1",
      inputHash:"3".repeat(64),
      scope,
      sourceId,
      result:firstResult
    });
    expect(replay.insertedEvidence).toBe(0);
    expect(replay.checkpoint.version).toBe(1);

    const secondRecord=evidence("event-2",20);
    const secondResult={
      sourceId,
      checkpointBefore:"cursor-2",
      nextCursor:"cursor-3",
      records:[firstRecord,secondRecord],
      batchHash:sha256Hex({page:2}),
      observedAt:"2026-09-25T20:02:00.000Z"
    };
    const second=await store.commitPage({
      requestId:"analytics-run-2",
      inputHash:"4".repeat(64),
      scope,
      sourceId,
      expectedCheckpointHash:first.checkpoint.checkpointHash,
      fromCursor:"cursor-2",
      result:secondResult
    });
    expect(second.insertedEvidence).toBe(1);
    expect(second.checkpoint).toMatchObject({cursor:"cursor-3",version:2});

    const count=await db().query<{count:number}>(
      `SELECT COUNT(*)::int AS count
       FROM analytics_ingestion_evidence
       WHERE company_id=$1 AND source_id=$2`,
      [scope.companyId,sourceId]
    );
    expect(count.rows[0]?.count).toBe(2);
  });

  it("serializes concurrent first-page writers so only one cursor can advance",async()=>{
    const raceSource="analytics-source-race";
    await db().query(
      "DELETE FROM analytics_ingestion_runs WHERE company_id=$1 AND source_id=$2",
      [scope.companyId,raceSource]
    );
    await db().query(
      "DELETE FROM analytics_ingestion_evidence WHERE company_id=$1 AND source_id=$2",
      [scope.companyId,raceSource]
    );
    await db().query(
      "DELETE FROM analytics_ingestion_checkpoints WHERE company_id=$1 AND source_id=$2",
      [scope.companyId,raceSource]
    );

    const makeResult=(requestId:string,cursor:string)=>({
      requestId,
      inputHash:sha256Hex({requestId}),
      scope,
      sourceId:raceSource,
      result:{
        sourceId:raceSource,
        nextCursor:cursor,
        records:[createAnalyticsEvidenceRecord({
          scope,
          sourceId:raceSource,
          sourceUrlHash:"8".repeat(64),
          providerBatchHash:sha256Hex({requestId}),
          externalId:requestId,
          sourceUpdatedAt:"2026-09-25T20:00:00.000Z",
          observedAt:"2026-09-25T20:05:00.000Z",
          fresh:true,
          payload:{requestId}
        })],
        batchHash:sha256Hex({requestId,cursor}),
        observedAt:"2026-09-25T20:05:00.000Z"
      }
    });

    const a=new PostgresAnalyticsIngestionStore(db());
    const b=new PostgresAnalyticsIngestionStore(db());
    const settled=await Promise.allSettled([
      a.commitPage(makeResult("race-a","cursor-a")),
      b.commitPage(makeResult("race-b","cursor-b"))
    ]);
    expect(settled.filter((item)=>item.status==="fulfilled")).toHaveLength(1);
    expect(settled.filter((item)=>item.status==="rejected")).toHaveLength(1);
    const rejected=settled.find((item)=>item.status==="rejected");
    expect(rejected && rejected.status==="rejected" ? rejected.reason : null)
      .toMatchObject({code:"CONFLICT"});
    const checkpoint=await a.getCheckpoint(scope,raceSource);
    expect(["cursor-a","cursor-b"]).toContain(checkpoint?.cursor);

    const count=await db().query<{count:number}>(
      `SELECT COUNT(*)::int AS count
       FROM analytics_ingestion_evidence
       WHERE company_id=$1 AND source_id=$2`,
      [scope.companyId,raceSource]
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it("rejects stale checkpoint writers and request-id input conflicts",async()=>{
    const store=new PostgresAnalyticsIngestionStore(db());
    const checkpoint=await store.getCheckpoint(scope,sourceId);
    expect(checkpoint?.cursor).toBe("cursor-3");

    await expect(store.commitPage({
      requestId:"analytics-run-stale",
      inputHash:"5".repeat(64),
      scope,
      sourceId,
      expectedCheckpointHash:"0".repeat(64),
      fromCursor:"cursor-2",
      result:{
        sourceId,
        checkpointBefore:"cursor-2",
        nextCursor:"cursor-4",
        records:[],
        batchHash:"6".repeat(64),
        observedAt:"2026-09-25T20:03:00.000Z"
      }
    })).rejects.toMatchObject({code:"CONFLICT"});

    const existing=await store.getRun(scope,sourceId,"analytics-run-1");
    expect(existing).not.toBeNull();
    await expect(store.commitPage({
      requestId:"analytics-run-1",
      inputHash:"f".repeat(64),
      scope,
      sourceId,
      expectedCheckpointHash:checkpoint?.checkpointHash,
      fromCursor:"cursor-3",
      result:{
        sourceId,
        checkpointBefore:"cursor-3",
        nextCursor:"cursor-4",
        records:[],
        batchHash:"7".repeat(64),
        observedAt:"2026-09-25T20:04:00.000Z"
      }
    })).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
  });
});
