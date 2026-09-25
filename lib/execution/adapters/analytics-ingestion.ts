import { z } from "zod";
import { createAnalyticsEvidenceRecord, type AnalyticsIngestionEvidenceStore, type AnalyticsIngestionResult } from "@/lib/analytics/ingestion";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { validateCapabilityInput } from "@/lib/domain/capabilities";
import {
  createBusinessActionAdapterResult,
  type AuthorizedBusinessActionRequest,
  type BusinessActionAdapter,
  type BusinessActionExecutionContext
} from "@/lib/execution/adapters/business-action";
import {
  assertAdapterRequest,
  providerRequestHeaders,
  readBoundedJson,
  requireBrokeredCredential,
  ORDINARY_INTEGRATION_RETRY_TAXONOMY,
  type BusinessActionAdapterDeclaration
} from "@/lib/execution/adapters/ordinary-integration-framework";

export const ANALYTICS_DATA_INGESTION_ADAPTER_VERSION="1.0.0";

const environmentSchema=z.enum(["development","staging","production"]);
const fieldTypeSchema=z.enum(["string","number","boolean","datetime","object","array"]);

export interface AnalyticsSourceConfiguration {
  id:string;
  companyId:string;
  environment:z.infer<typeof environmentSchema>;
  credentialProviderId:string;
  url:string;
  itemsPath?:string;
  nextCursorPath?:string;
  externalIdPath?:string;
  sourceUpdatedAtPath?:string;
  cursorQueryParam?:string;
  limitQueryParam?:string;
  readScopes?:readonly string[];
  maxResponseBytes?:number;
  maxFreshnessSeconds?:number;
  schema:{
    fields:Record<string,z.infer<typeof fieldTypeSchema>>;
    required?:readonly string[];
  };
}

const DECLARATION:BusinessActionAdapterDeclaration=Object.freeze({
  capability:"analytics.ingest.read",
  provider:"analytics",
  credentialMode:"brokered-lease",
  minimumScopes:Object.freeze(["analytics.read"]),
  timeoutMs:Object.freeze({min:100,max:120_000}),
  idempotency:"required",
  retryTaxonomy:ORDINARY_INTEGRATION_RETRY_TAXONOMY,
  providerOperationId:"required",
  statusResume:"not-supported",
  maxResponseBytes:2_000_000,
  auditEvidence:"hashed-provider-evidence",
  verificationStrategy:"provider-object-read",
  cancellation:"not-supported",
  tenantEnvironmentBinding:true,
  truthSemantics:"provider-acceptance-is-not-business-truth"
});

type ValidatedConfiguration=ReturnType<typeof validateConfiguration>;

function pathValue(value:string|undefined,fallback:string,label:string){
  const candidate=value?.trim()||fallback;
  if(!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(candidate)){
    throw new ControlPlaneError("VALIDATION_FAILED",`${label} is invalid`);
  }
  return candidate;
}

function queryName(value:string|undefined,fallback:string,label:string){
  const candidate=value?.trim()||fallback;
  if(!/^[A-Za-z0-9_.-]{1,100}$/.test(candidate)){
    throw new ControlPlaneError("VALIDATION_FAILED",`${label} is invalid`);
  }
  return candidate;
}

function validateConfiguration(configuration:AnalyticsSourceConfiguration){
  if(!/^[A-Za-z0-9._:-]{1,160}$/.test(configuration.id)){
    throw new ControlPlaneError("VALIDATION_FAILED","Analytics source id is invalid");
  }
  if(!/^[A-Za-z0-9._:@+-]{1,200}$/.test(configuration.credentialProviderId)){
    throw new ControlPlaneError("VALIDATION_FAILED","Analytics credentialProviderId is invalid");
  }
  const baseUrl=new URL(configuration.url);
  if(baseUrl.protocol!=="https:" || baseUrl.username || baseUrl.password || baseUrl.hash){
    throw new ControlPlaneError("VALIDATION_FAILED","Analytics URL must be credential-free HTTPS");
  }
  const maxResponseBytes=configuration.maxResponseBytes??1_000_000;
  if(!Number.isInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>2_000_000){
    throw new ControlPlaneError("VALIDATION_FAILED","Analytics maxResponseBytes must be 1-2000000");
  }
  const maxFreshnessSeconds=configuration.maxFreshnessSeconds??86_400;
  if(!Number.isInteger(maxFreshnessSeconds)||maxFreshnessSeconds<60||maxFreshnessSeconds>31_536_000){
    throw new ControlPlaneError("VALIDATION_FAILED","Analytics maxFreshnessSeconds is invalid");
  }
  const fieldEntries=Object.entries(configuration.schema?.fields??{});
  if(fieldEntries.length<1||fieldEntries.length>200){
    throw new ControlPlaneError("VALIDATION_FAILED","Analytics schema fields must contain 1-200 entries");
  }
  for(const [field,type] of fieldEntries){
    pathValue(field,field,"Analytics schema field");
    fieldTypeSchema.parse(type);
  }
  const required=[...new Set(configuration.schema.required??[])];
  if(required.some((field)=>!(field in configuration.schema.fields))){
    throw new ControlPlaneError("VALIDATION_FAILED","Analytics required field is not declared");
  }
  return Object.freeze({
    ...configuration,
    environment:environmentSchema.parse(configuration.environment),
    url:baseUrl.toString(),
    itemsPath:pathValue(configuration.itemsPath,"items","Analytics itemsPath"),
    nextCursorPath:pathValue(configuration.nextCursorPath,"nextCursor","Analytics nextCursorPath"),
    externalIdPath:pathValue(configuration.externalIdPath,"id","Analytics externalIdPath"),
    sourceUpdatedAtPath:pathValue(configuration.sourceUpdatedAtPath,"updatedAt","Analytics sourceUpdatedAtPath"),
    cursorQueryParam:queryName(configuration.cursorQueryParam,"cursor","Analytics cursorQueryParam"),
    limitQueryParam:queryName(configuration.limitQueryParam,"limit","Analytics limitQueryParam"),
    readScopes:Object.freeze([...(configuration.readScopes??["analytics.read"])]),
    maxResponseBytes,
    maxFreshnessSeconds,
    schema:Object.freeze({
      fields:Object.freeze({...configuration.schema.fields}),
      required:Object.freeze(required)
    })
  });
}

function getAtPath(value:unknown,path:string):unknown{
  return path.split(".").reduce<unknown>((current,key)=>{
    if(current===null||current===undefined||typeof current!=="object"||Array.isArray(current)) return undefined;
    return (current as Record<string,unknown>)[key];
  },value);
}

function isObject(value:unknown):value is Record<string,unknown>{
  return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
}

function matchesType(value:unknown,type:string){
  if(type==="string") return typeof value==="string";
  if(type==="number") return typeof value==="number"&&Number.isFinite(value);
  if(type==="boolean") return typeof value==="boolean";
  if(type==="datetime") return typeof value==="string"&&Number.isFinite(Date.parse(value));
  if(type==="object") return isObject(value);
  if(type==="array") return Array.isArray(value);
  return false;
}

function validatePayload(payload:unknown,configuration:ValidatedConfiguration){
  if(!isObject(payload)) throw new ControlPlaneError("UNAVAILABLE","Analytics item must be an object");
  for(const field of configuration.schema.required){
    if(getAtPath(payload,field)===undefined){
      throw new ControlPlaneError("UNAVAILABLE",`Analytics item is missing required field ${field}`);
    }
  }
  for(const [field,type] of Object.entries(configuration.schema.fields)){
    const value=getAtPath(payload,field);
    if(value!==undefined && !matchesType(value,type)){
      throw new ControlPlaneError("UNAVAILABLE",`Analytics item field ${field} failed schema validation`);
    }
  }
  return payload;
}

export class AnalyticsDataIngestionAdapter implements BusinessActionAdapter {
  readonly id="analytics-data-ingestion";
  readonly version=ANALYTICS_DATA_INGESTION_ADAPTER_VERSION;
  readonly declaration=DECLARATION;
  private readonly configurations:ReadonlyMap<string,ValidatedConfiguration>;
  private readonly fetchImpl:typeof fetch;
  private readonly now:()=>Date;

  constructor(
    configurations:readonly AnalyticsSourceConfiguration[],
    private readonly store:AnalyticsIngestionEvidenceStore,
    options:{fetchImpl?:typeof fetch;now?:()=>Date}={}
  ){
    const entries=configurations.map((item)=>{
      const validated=validateConfiguration(item);
      return [validated.id,validated] as const;
    });
    if(entries.length===0||new Set(entries.map(([id])=>id)).size!==entries.length){
      throw new ControlPlaneError("VALIDATION_FAILED","Analytics source configurations must be non-empty and unique");
    }
    this.configurations=new Map(entries);
    this.fetchImpl=options.fetchImpl??fetch;
    this.now=options.now??(()=>new Date());
  }

  private configurationFor(request:AuthorizedBusinessActionRequest,sourceId:string){
    const configuration=this.configurations.get(sourceId);
    if(
      !configuration
      || configuration.companyId!==request.scope.companyId
      || configuration.environment!==request.scope.environment
    ){
      throw new ControlPlaneError("POLICY_BLOCKED","Analytics source is outside authoritative tenant/environment scope");
    }
    return configuration;
  }

  credentialRequirement(request:AuthorizedBusinessActionRequest){
    const input=validateCapabilityInput<{companyId:string;sourceId:string;limit:number}>(
      "analytics.ingest.read",request.input
    );
    const configuration=this.configurationFor(request,input.sourceId);
    return {providerId:configuration.credentialProviderId,requiredScopes:configuration.readScopes};
  }

  async execute(request:AuthorizedBusinessActionRequest,context?:BusinessActionExecutionContext){
    const input=validateCapabilityInput<{companyId:string;sourceId:string;limit:number}>(
      "analytics.ingest.read",request.input
    );
    const configuration=this.configurationFor(request,input.sourceId);
    assertAdapterRequest(request,DECLARATION,configuration);
    if(input.companyId!==request.scope.companyId){
      throw new ControlPlaneError("FORBIDDEN","Analytics company does not match authoritative Job scope");
    }

    const existing=await this.store.getRun(request.id);
    if(existing){
      if(existing.inputHash!==request.inputHash){
        throw new ControlPlaneError("IDEMPOTENCY_CONFLICT","Analytics request ID was reused with different input");
      }
      return createBusinessActionAdapterResult({
        source:"business-action-adapter",
        requestId:request.id,
        adapterId:this.id,
        adapterVersion:this.version,
        status:"completed",
        output:existing.result,
        retryable:false,
        retryClass:"none",
        observedAt:existing.observedAt
      });
    }

    const credential=requireBrokeredCredential(
      context,
      {providerId:configuration.credentialProviderId,requiredScopes:configuration.readScopes},
      request.capability
    );
    const checkpoint=await this.store.getCheckpoint(request.scope,input.sourceId);
    const url=new URL(configuration.url);
    if(checkpoint?.cursor) url.searchParams.set(configuration.cursorQueryParam,checkpoint.cursor);
    url.searchParams.set(configuration.limitQueryParam,String(input.limit));

    let response:Response;
    try{
      response=await this.fetchImpl(url,{
        method:"GET",
        headers:{
          ...providerRequestHeaders({request,credential}),
          accept:"application/json"
        },
        signal:AbortSignal.timeout(request.timeoutMs)
      });
    }catch{
      return createBusinessActionAdapterResult({
        source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
        status:"failed",retryable:true,retryClass:"transport",observedAt:this.now().toISOString()
      });
    }

    const observedAt=this.now().toISOString();
    if(!response.ok){
      await readBoundedJson(response,configuration.maxResponseBytes).catch(()=>({}));
      const retryable=response.status===408||response.status===425||response.status===429||response.status>=500;
      return createBusinessActionAdapterResult({
        source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
        status:response.status>=400&&response.status<500&&!retryable?"rejected":"failed",
        retryable,
        retryClass:response.status===429?"rate-limit":response.status>=500?"provider-5xx":"provider-4xx",
        observedAt
      });
    }

    let body:unknown;
    try{body=await readBoundedJson(response,configuration.maxResponseBytes);}
    catch{
      return createBusinessActionAdapterResult({
        source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
        status:"failed",retryable:false,retryClass:"malformed-response",observedAt
      });
    }
    const items=getAtPath(body,configuration.itemsPath);
    if(!Array.isArray(items)||items.length>input.limit||items.length>500){
      throw new ControlPlaneError("UNAVAILABLE","Analytics provider page is missing bounded items");
    }
    const nextCursorRaw=getAtPath(body,configuration.nextCursorPath);
    if(nextCursorRaw!==undefined&&nextCursorRaw!==null&&typeof nextCursorRaw!=="string"){
      throw new ControlPlaneError("UNAVAILABLE","Analytics next cursor is malformed");
    }
    const nextCursor=typeof nextCursorRaw==="string"&&nextCursorRaw.length>0?nextCursorRaw:undefined;
    if(nextCursor && nextCursor.length>2000){
      throw new ControlPlaneError("UNAVAILABLE","Analytics next cursor exceeds configured bound");
    }

    const providerBatchHash=sha256Hex(body);
    const sourceUrlHash=sha256Hex(configuration.url);
    const seen=new Set<string>();
    const records=[];
    for(const raw of items){
      const payload=validatePayload(raw,configuration);
      const externalIdRaw=getAtPath(payload,configuration.externalIdPath);
      const sourceUpdatedRaw=getAtPath(payload,configuration.sourceUpdatedAtPath);
      if(
        (typeof externalIdRaw!=="string"&&typeof externalIdRaw!=="number")
        || !String(externalIdRaw)
        || typeof sourceUpdatedRaw!=="string"
        || !Number.isFinite(Date.parse(sourceUpdatedRaw))
      ){
        throw new ControlPlaneError("UNAVAILABLE","Analytics identity/freshness fields are malformed");
      }
      const sourceUpdatedAt=new Date(sourceUpdatedRaw).toISOString();
      const sourceMs=Date.parse(sourceUpdatedAt);
      const observedMs=Date.parse(observedAt);
      if(sourceMs>observedMs+300_000){
        throw new ControlPlaneError("UNAVAILABLE","Analytics source timestamp is implausibly in the future");
      }
      const record=createAnalyticsEvidenceRecord({
        sourceId:input.sourceId,
        sourceUrlHash,
        cursor:checkpoint?.cursor,
        providerBatchHash,
        externalId:String(externalIdRaw),
        sourceUpdatedAt,
        observedAt,
        fresh:observedMs-sourceMs<=configuration.maxFreshnessSeconds*1000,
        payload
      });
      if(seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
      records.push(record);
    }

    const resultBase={
      sourceId:input.sourceId,
      checkpointBefore:checkpoint?.cursor,
      nextCursor,
      records,
      observedAt
    };
    const result:AnalyticsIngestionResult={
      ...resultBase,
      batchHash:sha256Hex({
        ...resultBase,
        evidenceHashes:records.map((item)=>item.evidenceHash),
        providerBatchHash
      })
    };
    await this.store.commitPage({
      requestId:request.id,
      inputHash:request.inputHash,
      scope:request.scope,
      sourceId:input.sourceId,
      expectedCheckpointHash:checkpoint?.checkpointHash,
      fromCursor:checkpoint?.cursor,
      result
    });

    return createBusinessActionAdapterResult({
      source:"business-action-adapter",
      requestId:request.id,
      adapterId:this.id,
      adapterVersion:this.version,
      status:"completed",
      output:result,
      retryable:false,
      retryClass:"none",
      observedAt
    });
  }

  async status(){
    throw new ControlPlaneError("NOT_FOUND","Analytics ingestion completes only from the bounded page read");
  }
}

export function readAnalyticsSourceConfigurationsFromEnv(
  env:Readonly<Record<string,string|undefined>>=process.env
){
  const raw=env.GETDONE_ANALYTICS_SOURCES_JSON?.trim();
  if(!raw) throw new ControlPlaneError("UNAVAILABLE","GETDONE_ANALYTICS_SOURCES_JSON is required");
  let parsed:unknown;
  try{parsed=JSON.parse(raw);}catch{
    throw new ControlPlaneError("VALIDATION_FAILED","GETDONE_ANALYTICS_SOURCES_JSON must be valid JSON");
  }
  const schema=z.object({
    id:z.string().min(1),
    companyId:z.string().min(1),
    environment:environmentSchema,
    credentialProviderId:z.string().min(1),
    url:z.string().url(),
    itemsPath:z.string().optional(),
    nextCursorPath:z.string().optional(),
    externalIdPath:z.string().optional(),
    sourceUpdatedAtPath:z.string().optional(),
    cursorQueryParam:z.string().optional(),
    limitQueryParam:z.string().optional(),
    readScopes:z.array(z.string().min(1)).optional(),
    maxResponseBytes:z.number().int().positive().optional(),
    maxFreshnessSeconds:z.number().int().positive().optional(),
    schema:z.object({
      fields:z.record(fieldTypeSchema),
      required:z.array(z.string().min(1)).optional()
    }).strict()
  }).strict();
  return z.array(schema).min(1).parse(parsed) as readonly AnalyticsSourceConfiguration[];
}
