import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type {
  AnalyticsIngestionCheckpoint,
  AnalyticsIngestionEvidenceStore,
  AnalyticsIngestionRun
} from "@/lib/analytics/ingestion";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type {
  AuthorizedBusinessActionRequest,
  BusinessActionExecutionContext
} from "@/lib/execution/adapters/business-action";
import {
  AnalyticsDataIngestionAdapter,
  readAnalyticsSourceConfigurationsFromEnv
} from "@/lib/execution/adapters/analytics-ingestion";

type Scope=Pick<TrustedExecutionScope,"portfolioId"|"companyId"|"environment">;

class MemoryStore implements AnalyticsIngestionEvidenceStore {
  checkpoint:AnalyticsIngestionCheckpoint|null=null;
  runs=new Map<string,AnalyticsIngestionRun>();
  evidence=new Set<string>();
  commits=0;

  async getCheckpoint(_scope:Scope,_sourceId:string){return this.checkpoint;}
  async getRun(requestId:string){return this.runs.get(requestId)??null;}
  async commitPage(input:Parameters<AnalyticsIngestionEvidenceStore["commitPage"]>[0]){
    const existing=this.runs.get(input.requestId);
    if(existing){
      if(existing.inputHash!==input.inputHash) throw new Error("idempotency conflict");
      return {insertedEvidence:0,checkpoint:this.checkpoint!,run:existing};
    }
    if(this.checkpoint?.checkpointHash!==input.expectedCheckpointHash){
      throw new Error("checkpoint conflict");
    }
    let inserted=0;
    for(const item of input.result.records){
      if(!this.evidence.has(item.dedupeKey)){
        this.evidence.add(item.dedupeKey);
        inserted+=1;
      }
    }
    const version=(this.checkpoint?.version??0)+1;
    const base={
      scope:input.scope,
      sourceId:input.sourceId,
      cursor:input.result.nextCursor,
      version,
      updatedAt:input.result.observedAt
    };
    this.checkpoint={...base,checkpointHash:sha256Hex(base)};
    const run={
      requestId:input.requestId,
      inputHash:input.inputHash,
      result:input.result,
      resultHash:sha256Hex(input.result),
      observedAt:input.result.observedAt
    };
    this.runs.set(input.requestId,run);
    this.commits+=1;
    return {insertedEvidence:inserted,checkpoint:this.checkpoint,run};
  }
}

const scope={
  userId:"owner",
  portfolioId:"portfolio-a",
  companyId:"company-a",
  environment:"production" as const
};

const configuration={
  id:"warehouse-metrics",
  companyId:"company-a",
  environment:"production" as const,
  credentialProviderId:"analytics-provider",
  url:"https://analytics.example.test/v1/events",
  itemsPath:"data.items",
  nextCursorPath:"data.next",
  externalIdPath:"event.id",
  sourceUpdatedAtPath:"event.updatedAt",
  cursorQueryParam:"after",
  limitQueryParam:"pageSize",
  readScopes:["analytics.events.read"],
  maxFreshnessSeconds:3600,
  schema:{
    fields:{
      "event.id":"string" as const,
      "event.updatedAt":"datetime" as const,
      "metric":"number" as const
    },
    required:["event.id","event.updatedAt","metric"]
  }
};

function request(id="analytics-request"):AuthorizedBusinessActionRequest{
  const input={companyId:"company-a",sourceId:"warehouse-metrics",limit:100};
  return {
    id,
    jobId:`job-${id}`,
    scope,
    capability:"analytics.ingest.read",
    input,
    inputHash:sha256Hex(input),
    authorizationConsumptionHash:`consumption-${id}`,
    credentialLeaseId:`lease-${id}`,
    idempotencyKey:`idem-${id}`,
    timeoutMs:5_000,
    attempt:1
  };
}

function context():BusinessActionExecutionContext{
  return {
    credential:{
      leaseId:"lease-analytics",
      leaseHash:"a".repeat(64),
      providerId:"analytics-provider",
      capability:"analytics.ingest.read",
      grantedScopes:["analytics.events.read"],
      material:"short-lived-analytics-token",
      issuedAt:"2026-09-25T20:00:00Z",
      expiresAt:"2099-01-01T00:00:00Z"
    }
  };
}

describe("analytics data ingestion adapter",()=>{
  it("validates, deduplicates, annotates freshness/provenance and advances a durable cursor",async()=>{
    const store=new MemoryStore();
    let fetches=0;
    const adapter=new AnalyticsDataIngestionAdapter([configuration],store,{
      now:()=>new Date("2026-09-25T20:00:00Z"),
      fetchImpl:async(url,init)=>{
        fetches+=1;
        expect(String(url)).toContain("pageSize=100");
        expect((init?.headers as Record<string,string>).authorization).toBe("Bearer short-lived-analytics-token");
        return new Response(JSON.stringify({
          data:{
            items:[
              {event:{id:"e-1",updatedAt:"2026-09-25T19:59:30Z"},metric:10},
              {event:{id:"e-1",updatedAt:"2026-09-25T19:59:30Z"},metric:10},
              {event:{id:"e-2",updatedAt:"2026-09-25T18:00:00Z"},metric:20}
            ],
            next:"cursor-2"
          }
        }),{status:200});
      }
    });

    const first=await adapter.execute(request(),context());
    expect(first).toMatchObject({
      status:"completed",
      jobStateMutationApplied:false,
      output:{
        sourceId:"warehouse-metrics",
        nextCursor:"cursor-2"
      }
    });
    const output=first.output as {
      records:{externalId:string;fresh:boolean;dedupeKey:string;evidenceHash:string;provenance:{sourceUrlHash:string}}[];
    };
    expect(output.records).toHaveLength(2);
    expect(output.records.map((item)=>[item.externalId,item.fresh])).toEqual([
      ["e-1",true],
      ["e-2",false]
    ]);
    expect(output.records.every((item)=>/^[a-f0-9]{64}$/.test(item.dedupeKey))).toBe(true);
    expect(output.records.every((item)=>/^[a-f0-9]{64}$/.test(item.evidenceHash))).toBe(true);
    expect(store.checkpoint?.cursor).toBe("cursor-2");
    expect(store.commits).toBe(1);

    const replay=await adapter.execute(request(),context());
    expect(replay.output).toEqual(first.output);
    expect(fetches).toBe(1);
    expect(store.commits).toBe(1);
  });

  it("uses the persisted checkpoint on the next request and keeps duplicate evidence idempotent",async()=>{
    const store=new MemoryStore();
    const urls:string[]=[];
    const adapter=new AnalyticsDataIngestionAdapter([configuration],store,{
      now:()=>new Date("2026-09-25T20:00:00Z"),
      fetchImpl:async(url)=>{
        urls.push(String(url));
        return new Response(JSON.stringify({
          data:{
            items:[{event:{id:"e-1",updatedAt:"2026-09-25T19:59:30Z"},metric:10}],
            next:urls.length===1?"cursor-2":"cursor-3"
          }
        }),{status:200});
      }
    });
    await adapter.execute(request("page-1"),context());
    await adapter.execute(request("page-2"),context());
    expect(urls[1]).toContain("after=cursor-2");
    expect(store.evidence.size).toBe(1);
    expect(store.checkpoint?.cursor).toBe("cursor-3");
  });

  it("fails closed on schema drift, future timestamps, tenant drift, and unbounded/insecure configuration",async()=>{
    const store=new MemoryStore();
    const schemaAdapter=new AnalyticsDataIngestionAdapter([configuration],store,{
      fetchImpl:async()=>new Response(JSON.stringify({
        data:{items:[{event:{id:"e-1",updatedAt:"2026-09-25T20:00:00Z"},metric:"wrong"}]}
      }),{status:200})
    });
    await expect(schemaAdapter.execute(request("schema"),context()))
      .rejects.toMatchObject({code:"UNAVAILABLE"});

    const futureAdapter=new AnalyticsDataIngestionAdapter([configuration],new MemoryStore(),{
      now:()=>new Date("2026-09-25T20:00:00Z"),
      fetchImpl:async()=>new Response(JSON.stringify({
        data:{items:[{event:{id:"e-2",updatedAt:"2026-09-25T21:00:00Z"},metric:1}]}
      }),{status:200})
    });
    await expect(futureAdapter.execute(request("future"),context()))
      .rejects.toMatchObject({code:"UNAVAILABLE"});

    const tenant=request("tenant");
    tenant.scope={...scope,companyId:"company-b"};
    await expect(schemaAdapter.execute(tenant,context()))
      .rejects.toMatchObject({code:"POLICY_BLOCKED"});

    expect(()=>new AnalyticsDataIngestionAdapter([{
      ...configuration,url:"http://analytics.example.test/v1/events"
    }],new MemoryStore())).toThrow(/HTTPS/i);
    expect(()=>new AnalyticsDataIngestionAdapter([{
      ...configuration,maxResponseBytes:3_000_000
    }],new MemoryStore())).toThrow(/maxResponseBytes/i);
  });

  it("classifies provider failures without persisting cursor state",async()=>{
    const store=new MemoryStore();
    const adapter=new AnalyticsDataIngestionAdapter([configuration],store,{
      fetchImpl:async()=>new Response('{"error":"rate"}',{status:429})
    });
    await expect(adapter.execute(request("rate"),context())).resolves.toMatchObject({
      status:"failed",
      retryable:true,
      retryClass:"rate-limit"
    });
    expect(store.checkpoint).toBeNull();
    expect(store.commits).toBe(0);
  });

  it("parses strict server-only source configuration",()=>{
    const env={GETDONE_ANALYTICS_SOURCES_JSON:JSON.stringify([configuration])};
    expect(readAnalyticsSourceConfigurationsFromEnv(env)).toHaveLength(1);
    expect(()=>readAnalyticsSourceConfigurationsFromEnv({
      GETDONE_ANALYTICS_SOURCES_JSON:JSON.stringify([{...configuration,rawToken:"secret"}])
    })).toThrow();
  });
});
