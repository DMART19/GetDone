import { z } from "zod";
import { apiFailure, apiSuccess } from "@/lib/control-plane/schemas";
import { ControlPlaneError, toControlPlaneError } from "@/lib/control-plane/errors";
import { createCorrelationId, readIdempotencyKey } from "@/lib/control-plane/request-context";
import { readServerRuntimeEnvironment } from "@/lib/control-plane/runtime-environment.server";
import { getControlApiAdapter } from "@/lib/control-api/runtime.server";
import {
  INTEGRATION_PROVIDER_CATALOG,
  createIntegrationConfiguration,
  transitionIntegrationConfiguration,
  updateIntegrationConfiguration,
  type IntegrationProvider
} from "@/lib/integrations/configuration";
import { PostgresIntegrationConfigurationStore } from "@/lib/persistence/postgres/integration-configuration-store";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";
import { evaluateBrowserMutationOrigin } from "@/lib/security/browser-mutation-origin";
import {
  RATE_LIMIT_POLICIES,
  enforceRateLimit,
  rateLimitHeaders,
  tenantRateLimitKey
} from "@/lib/security/rate-limit.server";

const providerSchema=z.enum([
  "calendar","github","crm","analytics","gmail","slack","webhook","http"
]);

export const integrationConfigurationCreateSchema=z.object({
  id:z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  provider:providerSchema,
  displayName:z.string().min(1).max(120),
  capabilityNames:z.array(z.string().min(1).max(200)).min(1).max(100),
  grantedScopes:z.array(z.string().min(1).max(200)).min(1).max(100),
  credentialBindingId:z.string().min(1).max(200).regex(/^[A-Za-z0-9._:@+-]+$/).optional()
}).strict();

export const integrationConfigurationUpdateSchema=z.object({
  expectedVersion:z.number().int().positive(),
  displayName:z.string().min(1).max(120).optional(),
  capabilityNames:z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
  grantedScopes:z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
  credentialBindingId:z.union([
    z.string().min(1).max(200).regex(/^[A-Za-z0-9._:@+-]+$/),
    z.null()
  ]).optional()
}).strict();

export const integrationConfigurationActionSchema=z.object({
  action:z.enum(["enable","disable","revoke"]),
  expectedVersion:z.number().int().positive()
}).strict();

export function assertIntegrationOwnerPrincipal(input:{
  role:string;
  stepUpProof?:unknown;
},options:{requireStepUp?:boolean}={}){
  if(input.role!=="owner"){
    throw new ControlPlaneError("FORBIDDEN","Owner role is required for integration configuration");
  }
  if(options.requireStepUp&&!input.stepUpProof){
    throw new ControlPlaneError("STEP_UP_REQUIRED","Fresh step-up authentication is required");
  }
}

function safeId(value:string){
  if(!/^[A-Za-z0-9._:-]{1,160}$/.test(value)){
    throw new ControlPlaneError("VALIDATION_FAILED","Integration id is invalid");
  }
  return value;
}

async function body(request:Request){
  try{return await request.json();}
  catch{throw new ControlPlaneError("VALIDATION_FAILED","Request body must be valid JSON");}
}

function requireMutationOrigin(request:Request){
  const result=evaluateBrowserMutationOrigin(request);
  if(!result.allowed){
    throw new ControlPlaneError(
      "FORBIDDEN",
      `Browser mutation origin is not trusted: ${result.reason??"unknown"}`
    );
  }
}

function requireIdempotency(request:Request){
  const key=readIdempotencyKey(request.headers);
  if(!key) throw new ControlPlaneError("VALIDATION_FAILED","Idempotency-Key header is required");
  return key;
}

async function execute<T>(
  request:Request,
  operation:(input:{
    principal:Awaited<ReturnType<ReturnType<typeof getControlApiAdapter>["authenticate"]>>;
    store:PostgresIntegrationConfigurationStore;
  })=>Promise<T>,
  options:{status?:number;mutation?:boolean;stepUp?:boolean}={}
){
  const correlationId=createCorrelationId();
  const environment=readServerRuntimeEnvironment();
  try{
    if(options.mutation) requireMutationOrigin(request);
    const adapter=getControlApiAdapter();
    const principal=await adapter.authenticate(request);
    assertIntegrationOwnerPrincipal(principal,{requireStepUp:options.stepUp});
    if(options.mutation){
      await enforceRateLimit(
        RATE_LIMIT_POLICIES.integrationMutation,
        tenantRateLimitKey({
          portfolioId:principal.scope.portfolioId,
          companyId:principal.scope.companyId,
          userId:principal.scope.userId,
          sessionId:principal.sessionId
        },"integration-configuration")
      );
    }
    const database=getPostgresRuntimeFromEnv().database;
    const store=new PostgresIntegrationConfigurationStore(database);
    const data=await runWithPostgresTenantScope(principal.scope,()=>operation({principal,store}));
    return Response.json(apiSuccess(data,{correlationId,environment}),{
      status:options.status??200,
      headers:{"cache-control":"no-store","x-correlation-id":correlationId}
    });
  }catch(error){
    const normalized=toControlPlaneError(error,correlationId);
    return Response.json(
      apiFailure(normalized.code,normalized.message,{correlationId,environment}),
      {
        status:normalized.status,
        headers:{
          "cache-control":"no-store",
          "x-correlation-id":correlationId,
          ...rateLimitHeaders(normalized)
        }
      }
    );
  }
}

export function handleListIntegrationConfigurations(request:Request){
  return execute(request,async({principal,store})=>({
    integrations:await store.list(principal.scope),
    providers:INTEGRATION_PROVIDER_CATALOG
  }));
}

export function handleGetIntegrationConfiguration(request:Request,integrationId:string){
  return execute(request,async({principal,store})=>{
    const value=await store.get(principal.scope,safeId(integrationId));
    if(!value) throw new ControlPlaneError("NOT_FOUND","Integration configuration was not found");
    return value;
  });
}

export function handleCreateIntegrationConfiguration(request:Request){
  return execute(request,async({principal,store})=>{
    const parsed=integrationConfigurationCreateSchema.safeParse(await body(request));
    if(!parsed.success){
      throw new ControlPlaneError("VALIDATION_FAILED","Invalid integration configuration payload");
    }
    const record=createIntegrationConfiguration({
      scope:principal.scope,
      value:{
        ...parsed.data,
        provider:parsed.data.provider as IntegrationProvider
      }
    });
    return store.create(record,requireIdempotency(request));
  },{status:201,mutation:true});
}

export function handleUpdateIntegrationConfiguration(request:Request,integrationId:string){
  return execute(request,async({principal,store})=>{
    const parsed=integrationConfigurationUpdateSchema.safeParse(await body(request));
    if(!parsed.success){
      throw new ControlPlaneError("VALIDATION_FAILED","Invalid integration update payload");
    }
    const current=await store.get(principal.scope,safeId(integrationId));
    if(!current) throw new ControlPlaneError("NOT_FOUND","Integration configuration was not found");
    if(current.version!==parsed.data.expectedVersion){
      throw new ControlPlaneError("CONFLICT","Integration configuration version changed");
    }
    const updated=updateIntegrationConfiguration(current,{
      displayName:parsed.data.displayName,
      capabilityNames:parsed.data.capabilityNames,
      grantedScopes:parsed.data.grantedScopes,
      credentialBindingId:parsed.data.credentialBindingId,
      at:new Date().toISOString()
    });
    return store.save(updated,current.version);
  },{mutation:true});
}

export function handleIntegrationConfigurationAction(
  request:Request,
  integrationId:string
){
  return execute(request,async({principal,store})=>{
    const parsed=integrationConfigurationActionSchema.safeParse(await body(request));
    if(!parsed.success){
      throw new ControlPlaneError("VALIDATION_FAILED","Invalid integration action payload");
    }
    const current=await store.get(principal.scope,safeId(integrationId));
    if(!current) throw new ControlPlaneError("NOT_FOUND","Integration configuration was not found");
    if(current.version!==parsed.data.expectedVersion){
      throw new ControlPlaneError("CONFLICT","Integration configuration version changed");
    }
    if(parsed.data.action==="revoke"){
      assertIntegrationOwnerPrincipal(principal,{requireStepUp:true});
    }
    const updated=transitionIntegrationConfiguration(current,{
      action:parsed.data.action,
      at:new Date().toISOString()
    });
    return store.save(updated,current.version);
  },{
    mutation:true,
    stepUp:false
  });
}

export function handleIntegrationProviderCatalog(request:Request){
  return execute(request,async()=>INTEGRATION_PROVIDER_CATALOG);
}
