import { z } from "zod";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
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

export const GITHUB_STANDARD_OPERATION_ADAPTER_VERSION="1.0.0";

const environmentSchema=z.enum(["development","staging","production"]);
const repositoryPattern=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface GithubProviderConfiguration {
  id:string;
  companyId:string;
  environment:z.infer<typeof environmentSchema>;
  credentialProviderId:string;
  apiBaseUrl?:string;
  repositories:readonly string[];
  protectedBranches?:readonly string[];
  readScopes?:readonly string[];
  writeScopes?:readonly string[];
  maxResponseBytes?:number;
}

type ValidatedConfiguration=ReturnType<typeof validateConfiguration>;

const CAPABILITIES=[
  "github.repository.read",
  "github.branch.create",
  "github.commit.create",
  "github.protected-branch.commit",
  "github.pull-request.write",
  "github.issue.write",
  "github.pull-request.merge"
] as const;
type GithubCapability=typeof CAPABILITIES[number];

function declaration(
  capability:GithubCapability,
  read:boolean,
  strong:boolean
):BusinessActionAdapterDeclaration{
  return Object.freeze({
    capability,
    provider:"github",
    credentialMode:"brokered-lease",
    minimumScopes:Object.freeze(read?["github.read"]:["github.write"]),
    verificationScopes:read?undefined:Object.freeze(["github.read"]),
    timeoutMs:Object.freeze({min:100,max:120_000}),
    idempotency:"required",
    retryTaxonomy:ORDINARY_INTEGRATION_RETRY_TAXONOMY,
    providerOperationId:"required",
    statusResume:read?"not-supported":"supported",
    maxResponseBytes:2_000_000,
    auditEvidence:"hashed-provider-evidence",
    verificationStrategy:read?"provider-object-read":"provider-object-read",
    cancellation:"not-supported",
    tenantEnvironmentBinding:true,
    truthSemantics:"provider-acceptance-is-not-business-truth"
  });
}
const DECLARATIONS=new Map<GithubCapability,BusinessActionAdapterDeclaration>([
  ["github.repository.read",declaration("github.repository.read",true,false)],
  ["github.branch.create",declaration("github.branch.create",false,false)],
  ["github.commit.create",declaration("github.commit.create",false,false)],
  ["github.protected-branch.commit",declaration("github.protected-branch.commit",false,true)],
  ["github.pull-request.write",declaration("github.pull-request.write",false,false)],
  ["github.issue.write",declaration("github.issue.write",false,false)],
  ["github.pull-request.merge",declaration("github.pull-request.merge",false,true)]
]);
void declaration;

function validateConfiguration(configuration:GithubProviderConfiguration){
  if(!/^[A-Za-z0-9._-]{1,160}$/.test(configuration.id)){
    throw new ControlPlaneError("VALIDATION_FAILED","GitHub configuration id is invalid");
  }
  if(!/^[A-Za-z0-9._:@+-]{1,200}$/.test(configuration.credentialProviderId)){
    throw new ControlPlaneError("VALIDATION_FAILED","GitHub credentialProviderId is invalid");
  }
  const api=new URL(configuration.apiBaseUrl??"https://api.github.com/");
  if(api.protocol!=="https:"||api.username||api.password||api.hash||api.search){
    throw new ControlPlaneError("VALIDATION_FAILED","GitHub API base URL must be credential-free HTTPS");
  }
  const repositories=[...new Set(configuration.repositories)];
  if(repositories.length<1||repositories.length>200||repositories.some((item)=>!repositoryPattern.test(item))){
    throw new ControlPlaneError("VALIDATION_FAILED","GitHub repository allowlist is invalid");
  }
  const protectedBranches=[...new Set(configuration.protectedBranches??["main","master"])];
  if(protectedBranches.some((item)=>!item||item.length>255||item.includes(".."))){
    throw new ControlPlaneError("VALIDATION_FAILED","GitHub protected branch configuration is invalid");
  }
  const maxResponseBytes=configuration.maxResponseBytes??1_000_000;
  if(!Number.isInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>2_000_000){
    throw new ControlPlaneError("VALIDATION_FAILED","GitHub maxResponseBytes must be 1-2000000");
  }
  return Object.freeze({
    ...configuration,
    environment:environmentSchema.parse(configuration.environment),
    apiBaseUrl:api.toString().replace(/\/?$/,"/"),
    repositories:Object.freeze(repositories),
    protectedBranches:Object.freeze(protectedBranches),
    readScopes:Object.freeze([...(configuration.readScopes??["github.read"])]),
    writeScopes:Object.freeze([...(configuration.writeScopes??["github.write","github.read"])]),
    maxResponseBytes
  });
}

function encode(value:string){return Buffer.from(value,"utf8").toString("base64url");}
function decode(value:string){
  try{return Buffer.from(value,"base64url").toString("utf8");}
  catch{throw new ControlPlaneError("VALIDATION_FAILED","GitHub operation lineage is malformed");}
}
function safeRepoPath(path:string){
  return path.split("/").map((part)=>encodeURIComponent(part)).join("/");
}
function apiUrl(configuration:ValidatedConfiguration,relative:string){
  return new URL(relative.replace(/^\//,""),configuration.apiBaseUrl);
}
function githubHeaders(
  request:AuthorizedBusinessActionRequest,
  credential:string,
  contentType=false
){
  return {
    ...providerRequestHeaders({
      request,
      credential,
      contentType:contentType?"application/json; charset=utf-8":undefined
    }),
    accept:"application/vnd.github+json",
    "x-github-api-version":"2022-11-28"
  };
}
function statusHeaders(credential:string){
  return {
    authorization:`Bearer ${credential}`,
    accept:"application/vnd.github+json",
    "x-github-api-version":"2022-11-28"
  };
}
function assertRepository(configuration:ValidatedConfiguration,repository:string){
  if(!configuration.repositories.includes(repository)){
    throw new ControlPlaneError("POLICY_BLOCKED","GitHub repository is outside the configured allowlist");
  }
}
function isProtected(configuration:ValidatedConfiguration,branch:string){
  return configuration.protectedBranches.includes(branch);
}
function operationId(input:{
  configurationId:string;
  capability:GithubCapability;
  kind:"branch"|"commit"|"pr"|"issue"|"merge";
  repository:string;
  identifier:string;
  expected:string;
}){
  const payload=encode(JSON.stringify({
    r:input.repository,
    i:input.identifier,
    e:input.expected
  }));
  const value=`gh:${input.configurationId}:${input.capability}:${input.kind}:${payload}`;
  if(value.length>500){
    throw new ControlPlaneError("VALIDATION_FAILED","GitHub provider operation lineage exceeds limit");
  }
  return value;
}
function parseOperationId(
  configurations:ReadonlyMap<string,ValidatedConfiguration>,
  value:string
){
  const match=/^gh:([A-Za-z0-9._-]+):(github\.[A-Za-z0-9.-]+):(branch|commit|pr|issue|merge):([A-Za-z0-9_-]+)$/.exec(value);
  if(!match) throw new ControlPlaneError("NOT_FOUND","GitHub provider operation is malformed");
  const configuration=configurations.get(match[1]);
  if(!configuration) throw new ControlPlaneError("NOT_FOUND","GitHub provider configuration is unavailable");
  if(!CAPABILITIES.includes(match[2] as GithubCapability)){
    throw new ControlPlaneError("NOT_FOUND","GitHub provider capability is unavailable");
  }
  let payload:unknown;
  try{payload=JSON.parse(decode(match[4]));}
  catch{throw new ControlPlaneError("VALIDATION_FAILED","GitHub provider operation payload is malformed");}
  if(
    !payload||typeof payload!=="object"||Array.isArray(payload)
    || typeof (payload as Record<string,unknown>).r!=="string"
    || typeof (payload as Record<string,unknown>).i!=="string"
    || typeof (payload as Record<string,unknown>).e!=="string"
  ){
    throw new ControlPlaneError("VALIDATION_FAILED","GitHub provider operation payload is invalid");
  }
  return {
    configuration,
    capability:match[2] as GithubCapability,
    kind:match[3] as "branch"|"commit"|"pr"|"issue"|"merge",
    repository:(payload as Record<string,string>).r,
    identifier:(payload as Record<string,string>).i,
    expected:(payload as Record<string,string>).e
  };
}

async function requestJson(
  fetchImpl:typeof fetch,
  url:URL,
  init:RequestInit,
  maxResponseBytes:number
){
  const response=await fetchImpl(url,init);
  const body=await readBoundedJson(response,maxResponseBytes).catch((error)=>{
    if(response.ok) throw error;
    return {};
  });
  return {response,body};
}
function isObject(value:unknown):value is Record<string,unknown>{
  return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
}
function stringField(value:unknown,key:string){
  const raw=isObject(value)?value[key]:undefined;
  if(typeof raw!=="string"||!raw) throw new ControlPlaneError("UNAVAILABLE",`GitHub response is missing ${key}`);
  return raw;
}
function numberField(value:unknown,key:string){
  const raw=isObject(value)?value[key]:undefined;
  if(typeof raw!=="number"||!Number.isInteger(raw)||raw<1){
    throw new ControlPlaneError("UNAVAILABLE",`GitHub response is missing ${key}`);
  }
  return raw;
}
function normalizedPr(value:unknown){
  if(!isObject(value)) throw new ControlPlaneError("UNAVAILABLE","GitHub pull request response is malformed");
  const head=isObject(value.head)?value.head.ref:undefined;
  const base=isObject(value.base)?value.base.ref:undefined;
  return {
    title:typeof value.title==="string"?value.title:"",
    body:typeof value.body==="string"?value.body:"",
    state:typeof value.state==="string"?value.state:"",
    draft:value.draft===true,
    head:typeof head==="string"?head:"",
    base:typeof base==="string"?base:""
  };
}
function normalizedIssue(value:unknown){
  if(!isObject(value)) throw new ControlPlaneError("UNAVAILABLE","GitHub issue response is malformed");
  const labels=Array.isArray(value.labels)
    ? value.labels.map((item)=>{
        if(typeof item==="string") return item;
        return isObject(item)&&typeof item.name==="string"?item.name:"";
      }).filter(Boolean).sort()
    : [];
  return {
    title:typeof value.title==="string"?value.title:"",
    body:typeof value.body==="string"?value.body:"",
    state:typeof value.state==="string"?value.state:"",
    labels
  };
}

export class GithubStandardOperationAdapter implements BusinessActionAdapter {
  readonly id="github-standard-operation";
  readonly version=GITHUB_STANDARD_OPERATION_ADAPTER_VERSION;
  readonly declarations=Object.freeze(Object.fromEntries(DECLARATIONS));
  private readonly configurations:ReadonlyMap<string,ValidatedConfiguration>;
  private readonly fetchImpl:typeof fetch;
  private readonly now:()=>Date;

  constructor(
    configurations:readonly GithubProviderConfiguration[],
    options:{fetchImpl?:typeof fetch;now?:()=>Date}={}
  ){
    const entries=configurations.map((item)=>{
      const validated=validateConfiguration(item);
      return [validated.id,validated] as const;
    });
    if(entries.length===0||new Set(entries.map(([id])=>id)).size!==entries.length){
      throw new ControlPlaneError("VALIDATION_FAILED","GitHub configurations must be non-empty and unique");
    }
    this.configurations=new Map(entries);
    this.fetchImpl=options.fetchImpl??fetch;
    this.now=options.now??(()=>new Date());
  }

  private inputBase(request:AuthorizedBusinessActionRequest){
    if(!CAPABILITIES.includes(request.capability as GithubCapability)){
      throw new ControlPlaneError("FORBIDDEN","GitHub adapter received unsupported capability");
    }
    const input=request.input as {connectionId?:unknown;repository?:unknown;companyId?:unknown};
    if(typeof input.connectionId!=="string"||typeof input.repository!=="string"){
      throw new ControlPlaneError("VALIDATION_FAILED","GitHub input is missing connectionId/repository");
    }
    const configuration=this.configurations.get(input.connectionId);
    if(
      !configuration
      || configuration.companyId!==request.scope.companyId
      || configuration.environment!==request.scope.environment
    ){
      throw new ControlPlaneError("POLICY_BLOCKED","GitHub connection is outside authoritative tenant/environment scope");
    }
    assertRepository(configuration,input.repository);
    if(input.companyId!==request.scope.companyId){
      throw new ControlPlaneError("FORBIDDEN","GitHub company does not match authoritative Job scope");
    }
    return {configuration,repository:input.repository};
  }

  credentialRequirement(request:AuthorizedBusinessActionRequest){
    const {configuration}=this.inputBase(request);
    const read=request.capability==="github.repository.read";
    return {
      providerId:configuration.credentialProviderId,
      requiredScopes:read?configuration.readScopes:configuration.writeScopes
    };
  }

  private declarationFor(request:AuthorizedBusinessActionRequest){
    const declaration=DECLARATIONS.get(request.capability as GithubCapability);
    if(!declaration) throw new ControlPlaneError("FORBIDDEN","GitHub capability is unavailable");
    return declaration;
  }

  async execute(request:AuthorizedBusinessActionRequest,context?:BusinessActionExecutionContext){
    const declaration=this.declarationFor(request);
    const {configuration,repository}=this.inputBase(request);
    assertAdapterRequest(request,declaration,configuration);
    const requirement=this.credentialRequirement(request);
    const credential=requireBrokeredCredential(context,requirement,request.capability);

    if(request.capability==="github.repository.read"){
      const input=validateCapabilityInput<{
        companyId:string;connectionId:string;repository:string;
        operation:"repository"|"branch"|"file"|"pull-request"|"issue"|"checks";
        branch?:string;path?:string;number?:number;ref?:string;
      }>("github.repository.read",request.input);
      const base=`repos/${repository}/`;
      let body:unknown;
      try{
        if(input.operation==="repository"){
          ({body}=await requestJson(this.fetchImpl,apiUrl(configuration,`repos/${repository}`),{
            method:"GET",headers:githubHeaders(request,credential)
          },configuration.maxResponseBytes));
        }else if(input.operation==="branch"){
          if(!input.branch) throw new ControlPlaneError("VALIDATION_FAILED","GitHub branch read requires branch");
          ({body}=await requestJson(this.fetchImpl,apiUrl(configuration,base+`branches/${encodeURIComponent(input.branch)}`),{
            method:"GET",headers:githubHeaders(request,credential)
          },configuration.maxResponseBytes));
        }else if(input.operation==="file"){
          if(!input.path) throw new ControlPlaneError("VALIDATION_FAILED","GitHub file read requires path");
          const url=apiUrl(configuration,base+`contents/${safeRepoPath(input.path)}`);
          if(input.ref) url.searchParams.set("ref",input.ref);
          ({body}=await requestJson(this.fetchImpl,url,{
            method:"GET",headers:githubHeaders(request,credential)
          },configuration.maxResponseBytes));
        }else if(input.operation==="pull-request"){
          if(!input.number) throw new ControlPlaneError("VALIDATION_FAILED","GitHub pull request read requires number");
          ({body}=await requestJson(this.fetchImpl,apiUrl(configuration,base+`pulls/${input.number}`),{
            method:"GET",headers:githubHeaders(request,credential)
          },configuration.maxResponseBytes));
        }else if(input.operation==="issue"){
          if(!input.number) throw new ControlPlaneError("VALIDATION_FAILED","GitHub issue read requires number");
          ({body}=await requestJson(this.fetchImpl,apiUrl(configuration,base+`issues/${input.number}`),{
            method:"GET",headers:githubHeaders(request,credential)
          },configuration.maxResponseBytes));
        }else{
          if(!input.ref) throw new ControlPlaneError("VALIDATION_FAILED","GitHub checks read requires ref");
          const [checks,statuses]=await Promise.all([
            requestJson(this.fetchImpl,apiUrl(configuration,base+`commits/${encodeURIComponent(input.ref)}/check-runs`),{
              method:"GET",headers:githubHeaders(request,credential)
            },configuration.maxResponseBytes),
            requestJson(this.fetchImpl,apiUrl(configuration,base+`commits/${encodeURIComponent(input.ref)}/status`),{
              method:"GET",headers:githubHeaders(request,credential)
            },configuration.maxResponseBytes)
          ]);
          if(!checks.response.ok||!statuses.response.ok){
            const failed=!checks.response.ok?checks.response:statuses.response;
            const classification=classifyHttpFailure(failed.status);
            return createBusinessActionAdapterResult({
              source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
              status:classification.resultStatus,retryable:classification.retryable,retryClass:classification.retryClass,
              observedAt:this.now().toISOString()
            });
          }
          body={checks:checks.body,status:statuses.body};
        }
      }catch(error){
        if(error instanceof ControlPlaneError) throw error;
        return createBusinessActionAdapterResult({
          source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
          status:"failed",retryable:true,retryClass:"transport",observedAt:this.now().toISOString()
        });
      }
      const observedAt=this.now().toISOString();
      return createBusinessActionAdapterResult({
        source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
        status:"completed",
        output:{
          repository,
          operation:input.operation,
          data:body,
          dataHash:sha256Hex(body),
          observedAt
        },
        retryable:false,retryClass:"none",observedAt
      });
    }

    if(request.capability==="github.branch.create"){
      const input=validateCapabilityInput<{
        companyId:string;connectionId:string;repository:string;branch:string;fromRef:string;
      }>("github.branch.create",request.input);
      if(isProtected(configuration,input.branch)){
        throw new ControlPlaneError("POLICY_BLOCKED","Creating a configured protected branch is blocked from ordinary branch creation");
      }
      const source=await requestJson(
        this.fetchImpl,
        apiUrl(configuration,`repos/${repository}/git/ref/heads/${encodeURIComponent(input.fromRef)}`),
        {method:"GET",headers:githubHeaders(request,credential)},
        configuration.maxResponseBytes
      );
      if(!source.response.ok){
        const failure=classifyHttpFailure(source.response.status);
        return createBusinessActionAdapterResult({
          source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
          status:failure.resultStatus,retryable:failure.retryable,retryClass:failure.retryClass,observedAt:this.now().toISOString()
        });
      }
      const sourceSha=isObject(source.body)&&isObject(source.body.object)&&typeof source.body.object.sha==="string"
        ? source.body.object.sha
        : undefined;
      if(!sourceSha) throw new ControlPlaneError("UNAVAILABLE","GitHub source ref response is malformed");
      const created=await requestJson(
        this.fetchImpl,
        apiUrl(configuration,`repos/${repository}/git/refs`),
        {
          method:"POST",
          headers:githubHeaders(request,credential,true),
          body:JSON.stringify({ref:`refs/heads/${input.branch}`,sha:sourceSha})
        },
        configuration.maxResponseBytes
      );
      const observedAt=this.now().toISOString();
      if(!created.response.ok){
        const failure=classifyHttpFailure(created.response.status);
        return createBusinessActionAdapterResult({
          source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
          status:failure.resultStatus,retryable:failure.retryable,retryClass:failure.retryClass,observedAt
        });
      }
      const op=operationId({
        configurationId:configuration.id,capability:"github.branch.create",kind:"branch",
        repository,identifier:input.branch,expected:sourceSha
      });
      return createBusinessActionAdapterResult({
        source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
        status:"accepted",providerOperationId:op,
        output:{repository,operation:"branch.create",providerAccepted:true,providerReference:sourceSha,acceptedAt:observedAt},
        retryable:false,retryClass:"none",observedAt
      });
    }

    if(request.capability==="github.commit.create"||request.capability==="github.protected-branch.commit"){
      const input=validateCapabilityInput<{
        companyId:string;connectionId:string;repository:string;branch:string;message:string;
        files:readonly {path:string;operation:"upsert"|"delete";content?:string}[];
      }>(request.capability,request.input);
      const protectedBranch=isProtected(configuration,input.branch);
      if(request.capability==="github.commit.create"&&protectedBranch){
        throw new ControlPlaneError("POLICY_BLOCKED","Protected branch changes require github.protected-branch.commit strong approval");
      }
      if(request.capability==="github.protected-branch.commit"&&!protectedBranch){
        throw new ControlPlaneError("POLICY_BLOCKED","Protected-branch capability may only target configured protected branches");
      }

      const baseRef=await requestJson(
        this.fetchImpl,
        apiUrl(configuration,`repos/${repository}/git/ref/heads/${encodeURIComponent(input.branch)}`),
        {method:"GET",headers:githubHeaders(request,credential)},
        configuration.maxResponseBytes
      );
      if(!baseRef.response.ok){
        const failure=classifyHttpFailure(baseRef.response.status);
        return createBusinessActionAdapterResult({
          source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
          status:failure.resultStatus,retryable:failure.retryable,retryClass:failure.retryClass,observedAt:this.now().toISOString()
        });
      }
      const baseSha=isObject(baseRef.body)&&isObject(baseRef.body.object)&&typeof baseRef.body.object.sha==="string"
        ? baseRef.body.object.sha:undefined;
      if(!baseSha) throw new ControlPlaneError("UNAVAILABLE","GitHub branch ref response is malformed");

      const baseCommit=await requestJson(
        this.fetchImpl,
        apiUrl(configuration,`repos/${repository}/git/commits/${baseSha}`),
        {method:"GET",headers:githubHeaders(request,credential)},
        configuration.maxResponseBytes
      );
      const baseTreeSha=isObject(baseCommit.body)&&isObject(baseCommit.body.tree)&&typeof baseCommit.body.tree.sha==="string"
        ? baseCommit.body.tree.sha:undefined;
      if(!baseCommit.response.ok||!baseTreeSha){
        throw new ControlPlaneError("UNAVAILABLE","GitHub base commit/tree lookup failed");
      }

      const treeEntries=[];
      for(const file of input.files){
        if(file.operation==="delete"){
          treeEntries.push({path:file.path,mode:"100644",type:"blob",sha:null});
          continue;
        }
        const blob=await requestJson(
          this.fetchImpl,
          apiUrl(configuration,`repos/${repository}/git/blobs`),
          {
            method:"POST",
            headers:githubHeaders(request,credential,true),
            body:JSON.stringify({content:file.content,encoding:"utf-8"})
          },
          configuration.maxResponseBytes
        );
        const blobSha=blob.response.ok&&isObject(blob.body)&&typeof blob.body.sha==="string"?blob.body.sha:undefined;
        if(!blobSha) throw new ControlPlaneError("UNAVAILABLE","GitHub blob creation failed");
        treeEntries.push({path:file.path,mode:"100644",type:"blob",sha:blobSha});
      }
      const tree=await requestJson(
        this.fetchImpl,
        apiUrl(configuration,`repos/${repository}/git/trees`),
        {
          method:"POST",headers:githubHeaders(request,credential,true),
          body:JSON.stringify({base_tree:baseTreeSha,tree:treeEntries})
        },
        configuration.maxResponseBytes
      );
      const treeSha=tree.response.ok&&isObject(tree.body)&&typeof tree.body.sha==="string"?tree.body.sha:undefined;
      if(!treeSha) throw new ControlPlaneError("UNAVAILABLE","GitHub tree creation failed");

      const commit=await requestJson(
        this.fetchImpl,
        apiUrl(configuration,`repos/${repository}/git/commits`),
        {
          method:"POST",headers:githubHeaders(request,credential,true),
          body:JSON.stringify({message:input.message,tree:treeSha,parents:[baseSha]})
        },
        configuration.maxResponseBytes
      );
      const commitSha=commit.response.ok&&isObject(commit.body)&&typeof commit.body.sha==="string"?commit.body.sha:undefined;
      if(!commitSha) throw new ControlPlaneError("UNAVAILABLE","GitHub commit creation failed");

      const update=await requestJson(
        this.fetchImpl,
        apiUrl(configuration,`repos/${repository}/git/refs/heads/${encodeURIComponent(input.branch)}`),
        {
          method:"PATCH",headers:githubHeaders(request,credential,true),
          body:JSON.stringify({sha:commitSha,force:false})
        },
        configuration.maxResponseBytes
      );
      const observedAt=this.now().toISOString();
      if(!update.response.ok){
        const failure=classifyHttpFailure(update.response.status);
        return createBusinessActionAdapterResult({
          source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
          status:failure.resultStatus,retryable:failure.retryable,retryClass:failure.retryClass,observedAt
        });
      }
      const capability=request.capability as GithubCapability;
      const op=operationId({
        configurationId:configuration.id,capability,kind:"commit",
        repository,identifier:input.branch,expected:commitSha
      });
      return createBusinessActionAdapterResult({
        source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
        status:"accepted",providerOperationId:op,
        output:{repository,operation:"commit.create",providerAccepted:true,providerReference:commitSha,acceptedAt:observedAt},
        retryable:false,retryClass:"none",observedAt
      });
    }

    if(request.capability==="github.pull-request.write"){
      const input=validateCapabilityInput<{
        companyId:string;connectionId:string;repository:string;operation:"create"|"update";number?:number;
        title?:string;body?:string;head?:string;base?:string;draft?:boolean;state?:"open"|"closed";
      }>("github.pull-request.write",request.input);
      const url=input.operation==="create"
        ? apiUrl(configuration,`repos/${repository}/pulls`)
        : apiUrl(configuration,`repos/${repository}/pulls/${input.number}`);
      const payload=input.operation==="create"
        ? {title:input.title,body:input.body??"",head:input.head,base:input.base,draft:input.draft??false}
        : Object.fromEntries(Object.entries({
            title:input.title,body:input.body,state:input.state,base:input.base
          }).filter(([,value])=>value!==undefined));
      const result=await requestJson(this.fetchImpl,url,{
        method:input.operation==="create"?"POST":"PATCH",
        headers:githubHeaders(request,credential,true),
        body:JSON.stringify(payload)
      },configuration.maxResponseBytes);
      const observedAt=this.now().toISOString();
      if(!result.response.ok){
        const failure=classifyHttpFailure(result.response.status);
        return createBusinessActionAdapterResult({
          source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
          status:failure.resultStatus,retryable:failure.retryable,retryClass:failure.retryClass,observedAt
        });
      }
      const number=numberField(result.body,"number");
      const expected=sha256Hex(normalizedPr(result.body));
      const op=operationId({
        configurationId:configuration.id,capability:"github.pull-request.write",kind:"pr",
        repository,identifier:String(number),expected
      });
      return createBusinessActionAdapterResult({
        source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
        status:"accepted",providerOperationId:op,
        output:{repository,operation:`pull-request.${input.operation}`,providerAccepted:true,providerReference:String(number),acceptedAt:observedAt},
        retryable:false,retryClass:"none",observedAt
      });
    }

    if(request.capability==="github.issue.write"){
      const input=validateCapabilityInput<{
        companyId:string;connectionId:string;repository:string;operation:"create"|"update";number?:number;
        title?:string;body?:string;state?:"open"|"closed";labels?:string[];
      }>("github.issue.write",request.input);
      const url=input.operation==="create"
        ? apiUrl(configuration,`repos/${repository}/issues`)
        : apiUrl(configuration,`repos/${repository}/issues/${input.number}`);
      const payload=Object.fromEntries(Object.entries({
        title:input.title,body:input.body,state:input.state,labels:input.labels
      }).filter(([,value])=>value!==undefined));
      const result=await requestJson(this.fetchImpl,url,{
        method:input.operation==="create"?"POST":"PATCH",
        headers:githubHeaders(request,credential,true),
        body:JSON.stringify(payload)
      },configuration.maxResponseBytes);
      const observedAt=this.now().toISOString();
      if(!result.response.ok){
        const failure=classifyHttpFailure(result.response.status);
        return createBusinessActionAdapterResult({
          source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
          status:failure.resultStatus,retryable:failure.retryable,retryClass:failure.retryClass,observedAt
        });
      }
      const number=numberField(result.body,"number");
      const expected=sha256Hex(normalizedIssue(result.body));
      const op=operationId({
        configurationId:configuration.id,capability:"github.issue.write",kind:"issue",
        repository,identifier:String(number),expected
      });
      return createBusinessActionAdapterResult({
        source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
        status:"accepted",providerOperationId:op,
        output:{repository,operation:`issue.${input.operation}`,providerAccepted:true,providerReference:String(number),acceptedAt:observedAt},
        retryable:false,retryClass:"none",observedAt
      });
    }

    const input=validateCapabilityInput<{
      companyId:string;connectionId:string;repository:string;number:number;
      method:"merge"|"squash"|"rebase";commitTitle?:string;commitMessage?:string;
    }>("github.pull-request.merge",request.input);
    const result=await requestJson(
      this.fetchImpl,
      apiUrl(configuration,`repos/${repository}/pulls/${input.number}/merge`),
      {
        method:"PUT",headers:githubHeaders(request,credential,true),
        body:JSON.stringify({
          merge_method:input.method,
          commit_title:input.commitTitle,
          commit_message:input.commitMessage
        })
      },
      configuration.maxResponseBytes
    );
    const observedAt=this.now().toISOString();
    if(!result.response.ok){
      const failure=classifyHttpFailure(result.response.status);
      return createBusinessActionAdapterResult({
        source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
        status:failure.resultStatus,retryable:failure.retryable,retryClass:failure.retryClass,observedAt
      });
    }
    if(!isObject(result.body)||result.body.merged!==true||typeof result.body.sha!=="string"){
      throw new ControlPlaneError("UNAVAILABLE","GitHub merge response did not confirm provider acceptance");
    }
    const op=operationId({
      configurationId:configuration.id,capability:"github.pull-request.merge",kind:"merge",
      repository,identifier:String(input.number),expected:result.body.sha
    });
    return createBusinessActionAdapterResult({
      source:"business-action-adapter",requestId:request.id,adapterId:this.id,adapterVersion:this.version,
      status:"accepted",providerOperationId:op,
      output:{repository,operation:"pull-request.merge",providerAccepted:true,providerReference:result.body.sha,acceptedAt:observedAt},
      retryable:false,retryClass:"none",observedAt
    });
  }

  async status(
    input:{requestId:string;providerOperationId:string},
    context?:BusinessActionExecutionContext
  ):Promise<BusinessActionStatus>{
    const operation=parseOperationId(this.configurations,input.providerOperationId);
    assertRepository(operation.configuration,operation.repository);
    const credential=requireBrokeredCredential(
      context,
      {
        providerId:operation.configuration.credentialProviderId,
        requiredScopes:operation.configuration.readScopes
      },
      operation.capability
    );
    const base=`repos/${operation.repository}/`;
    let response:Response;
    let body:unknown;
    try{
      let relative:string;
      if(operation.kind==="branch"||operation.kind==="commit"){
        relative=base+`git/ref/heads/${encodeURIComponent(operation.identifier)}`;
      }else if(operation.kind==="pr"||operation.kind==="merge"){
        relative=base+`pulls/${Number(operation.identifier)}`;
      }else{
        relative=base+`issues/${Number(operation.identifier)}`;
      }
      const result=await requestJson(
        this.fetchImpl,
        apiUrl(operation.configuration,relative),
        {method:"GET",headers:statusHeaders(credential)},
        operation.configuration.maxResponseBytes
      );
      response=result.response;
      body=result.body;
    }catch{
      return createBusinessActionStatus({
        source:"business-action-adapter",requestId:input.requestId,
        providerOperationId:input.providerOperationId,adapterId:this.id,adapterVersion:this.version,
        state:"running",observedAt:this.now().toISOString()
      });
    }
    let state:BusinessActionStatus["state"]="running";
    if(!response.ok){
      state=response.status===404||response.status===408||response.status===425||response.status===429||response.status>=500
        ?"running":"failed";
    }else if(operation.kind==="branch"||operation.kind==="commit"){
      const sha=isObject(body)&&isObject(body.object)&&typeof body.object.sha==="string"?body.object.sha:undefined;
      state=sha===operation.expected?"completed":"running";
    }else if(operation.kind==="pr"){
      state=sha256Hex(normalizedPr(body))===operation.expected?"completed":"running";
    }else if(operation.kind==="issue"){
      state=sha256Hex(normalizedIssue(body))===operation.expected?"completed":"running";
    }else{
      const merged=isObject(body)&&body.merged===true;
      const mergeSha=isObject(body)&&typeof body.merge_commit_sha==="string"?body.merge_commit_sha:undefined;
      state=merged&&mergeSha===operation.expected?"completed":"running";
    }
    return createBusinessActionStatus({
      source:"business-action-adapter",requestId:input.requestId,
      providerOperationId:input.providerOperationId,adapterId:this.id,adapterVersion:this.version,
      state,observedAt:this.now().toISOString()
    });
  }
}

export function readGithubProviderConfigurationsFromEnv(
  env:Readonly<Record<string,string|undefined>>=process.env
){
  const raw=env.GETDONE_GITHUB_ACTIONS_JSON?.trim();
  if(!raw) throw new ControlPlaneError("UNAVAILABLE","GETDONE_GITHUB_ACTIONS_JSON is required");
  let parsed:unknown;
  try{parsed=JSON.parse(raw);}catch{
    throw new ControlPlaneError("VALIDATION_FAILED","GETDONE_GITHUB_ACTIONS_JSON must be valid JSON");
  }
  return z.array(z.object({
    id:z.string().min(1),
    companyId:z.string().min(1),
    environment:environmentSchema,
    credentialProviderId:z.string().min(1),
    apiBaseUrl:z.string().url().optional(),
    repositories:z.array(z.string().regex(repositoryPattern)).min(1),
    protectedBranches:z.array(z.string().min(1).max(255)).optional(),
    readScopes:z.array(z.string().min(1)).optional(),
    writeScopes:z.array(z.string().min(1)).optional(),
    maxResponseBytes:z.number().int().positive().optional()
  }).strict()).min(1).parse(parsed) as readonly GithubProviderConfiguration[];
}
