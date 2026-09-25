import { z } from "zod";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { validateCapabilityInput } from "@/lib/domain/capabilities";
import {
  createBusinessActionAdapterResult,
  createBusinessActionStatus,
  type AuthorizedBusinessActionRequest,
  type BusinessActionAdapter,
  type BusinessActionExecutionContext,
  type BusinessActionStatus
} from "@/lib/execution/adapters/business-action";
import {
  assertAdapterRequest,
  classifyHttpFailure,
  providerRequestHeaders,
  readBoundedJson,
  requireBrokeredCredential,
  ORDINARY_INTEGRATION_RETRY_TAXONOMY,
  type BusinessActionAdapterDeclaration
} from "@/lib/execution/adapters/ordinary-integration-framework";

export const CRM_BUSINESS_ACTION_ADAPTER_VERSION = "1.0.0";

const environmentSchema = z.enum(["development","staging","production"]);
const objectTypeSchema = z.enum(["contact","company","deal"]);
const scalarSchema = z.union([z.string(),z.number(),z.boolean(),z.null()]);
const propertiesSchema = z.record(z.string().min(1).max(160),scalarSchema);
const readInputSchema = z.object({
  companyId:z.string().min(1),
  connectionId:z.string().min(1),
  objectType:objectTypeSchema,
  recordId:z.string().min(1).max(300)
}).strict();
const writeInputSchema = z.object({
  companyId:z.string().min(1),
  connectionId:z.string().min(1),
  objectType:objectTypeSchema,
  operation:z.enum(["create","update"]),
  recordId:z.string().min(1).max(300).optional(),
  properties:propertiesSchema.refine((value)=>Object.keys(value).length>0,"CRM mutation properties cannot be empty")
}).strict().superRefine((value,ctx)=>{
  if(value.operation==="update" && !value.recordId){
    ctx.addIssue({code:z.ZodIssueCode.custom,path:["recordId"],message:"CRM update requires recordId"});
  }
  if(value.operation==="create" && value.recordId){
    ctx.addIssue({code:z.ZodIssueCode.custom,path:["recordId"],message:"CRM create recordId is provider-assigned"});
  }
});

export type CrmObjectType = z.infer<typeof objectTypeSchema>;

export interface CrmObjectEndpointConfiguration {
  collectionPath:string;
  itemPath:string;
}

export interface CrmProviderConfiguration {
  id:string;
  companyId:string;
  environment:z.infer<typeof environmentSchema>;
  credentialProviderId:string;
  baseUrl:string;
  objects:Record<CrmObjectType,CrmObjectEndpointConfiguration>;
  readScopes?:readonly string[];
  writeScopes?:readonly string[];
  idPath?:string;
  propertiesPath?:string;
  maxResponseBytes?:number;
}

export interface CrmBusinessActionAdapterOptions {
  fetchImpl?:typeof fetch;
  now?:()=>Date;
}

type ValidatedConfiguration = ReturnType<typeof validateConfiguration>;

const READ_DECLARATION:BusinessActionAdapterDeclaration=Object.freeze({
  capability:"crm.record.read",
  provider:"crm",
  credentialMode:"brokered-lease",
  minimumScopes:Object.freeze(["crm.read"]),
  timeoutMs:Object.freeze({min:100,max:120_000}),
  idempotency:"required",
  retryTaxonomy:ORDINARY_INTEGRATION_RETRY_TAXONOMY,
  providerOperationId:"required",
  statusResume:"not-supported",
  maxResponseBytes:1_000_000,
  auditEvidence:"hashed-provider-evidence",
  verificationStrategy:"provider-object-read",
  cancellation:"not-supported",
  tenantEnvironmentBinding:true,
  truthSemantics:"provider-acceptance-is-not-business-truth"
});

const WRITE_DECLARATION:BusinessActionAdapterDeclaration=Object.freeze({
  capability:"crm.record.write",
  provider:"crm",
  credentialMode:"brokered-lease",
  minimumScopes:Object.freeze(["crm.write","crm.read"]),
  verificationScopes:Object.freeze(["crm.read"]),
  timeoutMs:Object.freeze({min:100,max:120_000}),
  idempotency:"required",
  retryTaxonomy:ORDINARY_INTEGRATION_RETRY_TAXONOMY,
  providerOperationId:"required",
  statusResume:"supported",
  maxResponseBytes:1_000_000,
  auditEvidence:"hashed-provider-evidence",
  verificationStrategy:"provider-object-read",
  cancellation:"not-supported",
  tenantEnvironmentBinding:true,
  truthSemantics:"provider-acceptance-is-not-business-truth"
});

function safeRelativePath(value:string,label:string){
  const trimmed=value.trim().replace(/^\/+/, "");
  if(
    !trimmed
    || trimmed.includes("..")
    || trimmed.includes("?")
    || trimmed.includes("#")
    || trimmed.includes("\\")
    || /^https?:/i.test(trimmed)
  ){
    throw new ControlPlaneError("VALIDATION_FAILED",`${label} must be a safe relative provider path`);
  }
  return trimmed;
}

function dottedPath(value:string|undefined,fallback:string,label:string){
  const pathValue=(value?.trim()||fallback);
  if(!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(pathValue)){
    throw new ControlPlaneError("VALIDATION_FAILED",`${label} is invalid`);
  }
  return pathValue;
}

function validateConfiguration(configuration:CrmProviderConfiguration){
  if(!/^[A-Za-z0-9._-]+$/.test(configuration.id)){
    throw new ControlPlaneError("VALIDATION_FAILED","CRM provider configuration id is invalid");
  }
  if(!/^[A-Za-z0-9._:@+-]{1,200}$/.test(configuration.credentialProviderId)){
    throw new ControlPlaneError("VALIDATION_FAILED","CRM credentialProviderId is invalid");
  }
  const environment=environmentSchema.parse(configuration.environment);
  const baseUrl=new URL(configuration.baseUrl);
  if(baseUrl.protocol!=="https:" || baseUrl.username || baseUrl.password || baseUrl.hash || baseUrl.search){
    throw new ControlPlaneError("VALIDATION_FAILED","CRM base URL must be credential-free HTTPS");
  }
  const maxResponseBytes=configuration.maxResponseBytes??512_000;
  if(!Number.isInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>1_000_000){
    throw new ControlPlaneError("VALIDATION_FAILED","CRM maxResponseBytes must be 1-1000000");
  }
  const objects={} as Record<CrmObjectType,CrmObjectEndpointConfiguration>;
  for(const objectType of objectTypeSchema.options){
    const endpoint=configuration.objects?.[objectType];
    if(!endpoint) throw new ControlPlaneError("VALIDATION_FAILED",`CRM ${objectType} endpoint is required`);
    const collectionPath=safeRelativePath(endpoint.collectionPath,`CRM ${objectType} collectionPath`);
    const itemPath=safeRelativePath(endpoint.itemPath,`CRM ${objectType} itemPath`);
    if(!itemPath.includes("{recordId}")){
      throw new ControlPlaneError("VALIDATION_FAILED",`CRM ${objectType} itemPath requires {recordId}`);
    }
    objects[objectType]={collectionPath,itemPath};
  }
  return Object.freeze({
    ...configuration,
    environment,
    baseUrl:baseUrl.toString().replace(/\/?$/, "/"),
    maxResponseBytes,
    idPath:dottedPath(configuration.idPath,"id","CRM idPath"),
    propertiesPath:dottedPath(configuration.propertiesPath,"properties","CRM propertiesPath"),
    readScopes:Object.freeze([...(configuration.readScopes??["crm.read"])]),
    writeScopes:Object.freeze([...(configuration.writeScopes??["crm.write"])]),
    objects:Object.freeze(objects)
  });
}

function getAtPath(value:unknown,pathValue:string):unknown{
  return pathValue.split(".").reduce<unknown>((current,key)=>{
    if(!current || typeof current!=="object" || Array.isArray(current)) return undefined;
    return (current as Record<string,unknown>)[key];
  },value);
}

function normalizeProviderProperties(raw:unknown,configuration:ValidatedConfiguration){
  const value=getAtPath(raw,configuration.propertiesPath);
  const parsed=propertiesSchema.safeParse(value);
  if(!parsed.success){
    throw new ControlPlaneError("UNAVAILABLE","CRM provider record properties are malformed");
  }
  return parsed.data;
}

function extractProviderId(raw:unknown,configuration:ValidatedConfiguration){
  const id=getAtPath(raw,configuration.idPath);
  if(typeof id!=="string" && typeof id!=="number"){
    throw new ControlPlaneError("UNAVAILABLE","CRM provider response is missing record id");
  }
  const value=String(id);
  if(!value || value.length>300) throw new ControlPlaneError("UNAVAILABLE","CRM provider record id is invalid");
  return value;
}

function encode(value:string){return Buffer.from(value,"utf8").toString("base64url");}
function decode(value:string){
  try{return Buffer.from(value,"base64url").toString("utf8");}
  catch{throw new ControlPlaneError("VALIDATION_FAILED","CRM provider operation token is malformed");}
}

function providerOperationId(input:{
  configurationId:string;
  objectType:CrmObjectType;
  recordId:string;
  expectedHash:string;
  fields:readonly string[];
}){
  const id=`crm:${input.configurationId}:${input.objectType}:${encode(input.recordId)}:${input.expectedHash}:${encode(JSON.stringify(input.fields))}`;
  if(id.length>500) throw new ControlPlaneError("VALIDATION_FAILED","CRM verification lineage exceeds provider operation limit");
  return id;
}

function parseProviderOperationId(
  configurations:ReadonlyMap<string,ValidatedConfiguration>,
  value:string
){
  const match=/^crm:([^:]+):(contact|company|deal):([A-Za-z0-9_-]+):([a-f0-9]{64}):([A-Za-z0-9_-]+)$/.exec(value);
  if(!match) throw new ControlPlaneError("NOT_FOUND","CRM provider operation is malformed");
  const configuration=configurations.get(match[1]);
  if(!configuration) throw new ControlPlaneError("NOT_FOUND","CRM provider operation configuration is unavailable");
  const recordId=decode(match[3]);
  let fields:unknown;
  try{fields=JSON.parse(decode(match[5]));}
  catch{throw new ControlPlaneError("VALIDATION_FAILED","CRM verification fields are malformed");}
  if(!Array.isArray(fields) || fields.length<1 || fields.length>100 || !fields.every((item)=>typeof item==="string")){
    throw new ControlPlaneError("VALIDATION_FAILED","CRM verification fields are invalid");
  }
  return {
    configuration,
    objectType:match[2] as CrmObjectType,
    recordId,
    expectedHash:match[4],
    fields:[...new Set(fields)].sort()
  };
}

function itemUrl(configuration:ValidatedConfiguration,objectType:CrmObjectType,recordId:string){
  const template=configuration.objects[objectType].itemPath;
  const relative=template.replace("{recordId}",encodeURIComponent(recordId));
  return new URL(relative,configuration.baseUrl);
}

function collectionUrl(configuration:ValidatedConfiguration,objectType:CrmObjectType){
  return new URL(configuration.objects[objectType].collectionPath,configuration.baseUrl);
}

function expectedSubset(properties:Record<string,string|number|boolean|null>){
  const fields=Object.keys(properties).sort();
  return {fields,hash:sha256Hex(Object.fromEntries(fields.map((key)=>[key,properties[key]])))};
}

function observedSubset(
  properties:Record<string,string|number|boolean|null>,
  fields:readonly string[]
){
  return Object.fromEntries(fields.map((key)=>[key,properties[key]]));
}

export class CrmBusinessActionAdapter implements BusinessActionAdapter {
  readonly id="crm-business-action";
  readonly version=CRM_BUSINESS_ACTION_ADAPTER_VERSION;
  readonly declarations=Object.freeze({
    read:READ_DECLARATION,
    write:WRITE_DECLARATION
  });

  private readonly configurations:ReadonlyMap<string,ValidatedConfiguration>;
  private readonly fetchImpl:typeof fetch;
  private readonly now:()=>Date;

  constructor(
    configurations:readonly CrmProviderConfiguration[],
    options:CrmBusinessActionAdapterOptions={}
  ){
    const entries=configurations.map((configuration)=>{
      const validated=validateConfiguration(configuration);
      return [validated.id,validated] as const;
    });
    if(entries.length===0 || new Set(entries.map(([id])=>id)).size!==entries.length){
      throw new ControlPlaneError("VALIDATION_FAILED","CRM configurations must be non-empty and unique");
    }
    this.configurations=new Map(entries);
    this.fetchImpl=options.fetchImpl??fetch;
    this.now=options.now??(()=>new Date());
  }

  private configurationFor(request:AuthorizedBusinessActionRequest,connectionId:string){
    const configuration=this.configurations.get(connectionId);
    if(
      !configuration
      || configuration.companyId!==request.scope.companyId
      || configuration.environment!==request.scope.environment
    ){
      throw new ControlPlaneError("POLICY_BLOCKED","CRM connection is outside authoritative tenant/environment scope");
    }
    return configuration;
  }

  credentialRequirement(request:AuthorizedBusinessActionRequest){
    if(request.capability==="crm.record.read"){
      const input=readInputSchema.parse(request.input);
      const configuration=this.configurationFor(request,input.connectionId);
      return {providerId:configuration.credentialProviderId,requiredScopes:configuration.readScopes};
    }
    if(request.capability==="crm.record.write"){
      const input=writeInputSchema.parse(request.input);
      const configuration=this.configurationFor(request,input.connectionId);
      return {
        providerId:configuration.credentialProviderId,
        requiredScopes:[...new Set([...configuration.writeScopes,...configuration.readScopes])]
      };
    }
    throw new ControlPlaneError("FORBIDDEN","CRM adapter only accepts CRM record capabilities");
  }

  private credential(
    request:AuthorizedBusinessActionRequest,
    configuration:ValidatedConfiguration,
    context:BusinessActionExecutionContext|undefined
  ){
    const requirement=this.credentialRequirement(request);
    return requireBrokeredCredential(context,requirement,request.capability);
  }

  async execute(request:AuthorizedBusinessActionRequest,context?:BusinessActionExecutionContext){
    if(request.capability==="crm.record.read"){
      const input=validateCapabilityInput<z.infer<typeof readInputSchema>>("crm.record.read",request.input);
      const configuration=this.configurationFor(request,input.connectionId);
      assertAdapterRequest(request,READ_DECLARATION,configuration);
      if(input.companyId!==request.scope.companyId){
        throw new ControlPlaneError("FORBIDDEN","CRM company does not match authoritative Job scope");
      }
      const credential=this.credential(request,configuration,context);
      let response:Response;
      try{
        response=await this.fetchImpl(itemUrl(configuration,input.objectType,input.recordId),{
          method:"GET",
          headers:providerRequestHeaders({request,credential}),
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
        const failure=classifyHttpFailure(response.status);
        return createBusinessActionAdapterResult({
          source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
          status:failure.resultStatus,retryable:failure.retryable,retryClass:failure.retryClass,observedAt
        });
      }
      try{
        const raw=await readBoundedJson(response,configuration.maxResponseBytes);
        const recordId=extractProviderId(raw,configuration);
        const properties=normalizeProviderProperties(raw,configuration);
        return createBusinessActionAdapterResult({
          source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
          status:"completed",providerOperationId:`crm:${configuration.id}:${input.objectType}:${encode(recordId)}:read:${encode("[]")}`,
          output:{objectType:input.objectType,recordId,properties,observedAt},
          retryable:false,retryClass:"none",observedAt
        });
      }catch{
        return createBusinessActionAdapterResult({
          source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
          status:"failed",retryable:false,retryClass:"malformed-response",observedAt
        });
      }
    }

    const input=validateCapabilityInput<z.infer<typeof writeInputSchema>>("crm.record.write",request.input);
    const configuration=this.configurationFor(request,input.connectionId);
    assertAdapterRequest(request,WRITE_DECLARATION,configuration);
    if(input.companyId!==request.scope.companyId){
      throw new ControlPlaneError("FORBIDDEN","CRM company does not match authoritative Job scope");
    }
    const credential=this.credential(request,configuration,context);
    const expected=expectedSubset(input.properties);
    const target=input.operation==="create"
      ? collectionUrl(configuration,input.objectType)
      : itemUrl(configuration,input.objectType,input.recordId!);
    let response:Response;
    try{
      response=await this.fetchImpl(target,{
        method:input.operation==="create"?"POST":"PATCH",
        headers:providerRequestHeaders({request,credential,contentType:"application/json; charset=utf-8"}),
        body:JSON.stringify({properties:input.properties}),
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
      const failure=classifyHttpFailure(response.status);
      return createBusinessActionAdapterResult({
        source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
        status:failure.resultStatus,retryable:failure.retryable,retryClass:failure.retryClass,observedAt
      });
    }

    let raw:unknown={};
    try{raw=await readBoundedJson(response,configuration.maxResponseBytes);}
    catch{
      return createBusinessActionAdapterResult({
        source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
        status:"failed",retryable:false,retryClass:"malformed-response",observedAt
      });
    }
    let recordId=input.recordId;
    if(input.operation==="create"){
      try{recordId=extractProviderId(raw,configuration);}
      catch{
        return createBusinessActionAdapterResult({
          source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
          status:"failed",retryable:false,retryClass:"malformed-response",observedAt
        });
      }
    }
    const operationId=providerOperationId({
      configurationId:configuration.id,
      objectType:input.objectType,
      recordId:recordId!,
      expectedHash:expected.hash,
      fields:expected.fields
    });
    return createBusinessActionAdapterResult({
      source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
      status:"accepted",providerOperationId:operationId,
      output:{objectType:input.objectType,recordId,providerAccepted:true,acceptedAt:observedAt},
      retryable:false,retryClass:"none",observedAt
    });
  }

  async status(
    input:{requestId:string;providerOperationId:string},
    context?:BusinessActionExecutionContext
  ):Promise<BusinessActionStatus>{
    const parsed=parseProviderOperationId(this.configurations,input.providerOperationId);
    const requirement={
      providerId:parsed.configuration.credentialProviderId,
      requiredScopes:parsed.configuration.readScopes
    };
    const credential=requireBrokeredCredential(context,requirement,"crm.record.write");
    let state:BusinessActionStatus["state"]="running";
    try{
      const response=await this.fetchImpl(itemUrl(parsed.configuration,parsed.objectType,parsed.recordId),{
        method:"GET",
        headers:{authorization:`Bearer ${credential}`},
        signal:AbortSignal.timeout(30_000)
      });
      if(!response.ok){
        await readBoundedJson(response,parsed.configuration.maxResponseBytes).catch(()=>({}));
        state=[408,425,429].includes(response.status)||response.status>=500?"running":"failed";
      }else{
        const raw=await readBoundedJson(response,parsed.configuration.maxResponseBytes);
        const providerId=extractProviderId(raw,parsed.configuration);
        const properties=normalizeProviderProperties(raw,parsed.configuration);
        const hash=sha256Hex(observedSubset(properties,parsed.fields));
        state=providerId===parsed.recordId && hash===parsed.expectedHash?"completed":"running";
      }
    }catch(error){
      if(error instanceof ControlPlaneError && error.code==="UNAVAILABLE") state="failed";
      else state="running";
    }
    return createBusinessActionStatus({
      source:"business-action-adapter",
      requestId:input.requestId,
      providerOperationId:input.providerOperationId,
      adapterId:this.id,
      adapterVersion:this.version,
      state,
      observedAt:this.now().toISOString()
    });
  }
}

export function readCrmProviderConfigurationsFromEnv(
  env:Readonly<Record<string,string|undefined>>=process.env
){
  const raw=env.GETDONE_CRM_ACTIONS_JSON?.trim();
  if(!raw) throw new ControlPlaneError("UNAVAILABLE","GETDONE_CRM_ACTIONS_JSON is required");
  let parsed:unknown;
  try{parsed=JSON.parse(raw);}catch{
    throw new ControlPlaneError("VALIDATION_FAILED","GETDONE_CRM_ACTIONS_JSON must be valid JSON");
  }
  const endpoint=z.object({
    collectionPath:z.string().min(1),
    itemPath:z.string().min(1)
  }).strict();
  return z.array(z.object({
    id:z.string().min(1),
    companyId:z.string().min(1),
    environment:environmentSchema,
    credentialProviderId:z.string().min(1),
    baseUrl:z.string().url(),
    objects:z.object({
      contact:endpoint,
      company:endpoint,
      deal:endpoint
    }).strict(),
    readScopes:z.array(z.string().min(1)).optional(),
    writeScopes:z.array(z.string().min(1)).optional(),
    idPath:z.string().optional(),
    propertiesPath:z.string().optional(),
    maxResponseBytes:z.number().int().optional()
  }).strict()).min(1).parse(parsed) as readonly CrmProviderConfiguration[];
}
