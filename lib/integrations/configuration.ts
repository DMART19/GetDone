import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export const INTEGRATION_CONFIGURATION_CONTRACT_VERSION="1.0.0";

export type IntegrationProvider =
  | "calendar"
  | "github"
  | "crm"
  | "analytics"
  | "gmail"
  | "slack"
  | "webhook"
  | "http";

export type IntegrationConfigurationStatus =
  | "pending"
  | "active"
  | "disabled"
  | "revoked";

export type IntegrationHealth =
  | "unknown"
  | "healthy"
  | "degraded"
  | "unavailable";

export interface IntegrationVerificationSummary {
  id:string;
  health:IntegrationHealth;
  verifiedAt:string;
  evidenceHash:string;
  capabilityResults:Readonly<Record<string,"passed"|"failed"|"not-tested">>;
}

export interface IntegrationConfiguration {
  id:string;
  portfolioId:string;
  companyId:string;
  environment:TrustedExecutionScope["environment"];
  provider:IntegrationProvider;
  displayName:string;
  capabilityNames:readonly string[];
  grantedScopes:readonly string[];
  credentialBindingId?:string;
  status:IntegrationConfigurationStatus;
  health:IntegrationHealth;
  lastVerification?:IntegrationVerificationSummary;
  createdAt:string;
  updatedAt:string;
  version:number;
  configurationHash:string;
}

export interface IntegrationConfigurationInput {
  id:string;
  provider:IntegrationProvider;
  displayName:string;
  capabilityNames:readonly string[];
  grantedScopes:readonly string[];
  credentialBindingId?:string;
}

export interface IntegrationProviderDefinition {
  provider:IntegrationProvider;
  label:string;
  capabilities:readonly string[];
  suggestedScopes:readonly string[];
  supportsCredentialBinding:boolean;
}

export const INTEGRATION_PROVIDER_CATALOG:readonly IntegrationProviderDefinition[]=Object.freeze([
  {
    provider:"calendar",
    label:"Calendar",
    capabilities:Object.freeze([
      "calendar.event.read","calendar.event.create","calendar.event.update","calendar.event.cancel"
    ]),
    suggestedScopes:Object.freeze(["calendar.read","calendar.write"]),
    supportsCredentialBinding:true
  },
  {
    provider:"github",
    label:"GitHub",
    capabilities:Object.freeze([
      "github.repository.read","github.branch.create","github.commit.create",
      "github.protected-branch.commit","github.pull-request.write",
      "github.issue.write","github.pull-request.merge"
    ]),
    suggestedScopes:Object.freeze(["github.read","github.write"]),
    supportsCredentialBinding:true
  },
  {
    provider:"crm",
    label:"CRM",
    capabilities:Object.freeze(["crm.record.read","crm.record.write"]),
    suggestedScopes:Object.freeze(["crm.read","crm.write"]),
    supportsCredentialBinding:true
  },
  {
    provider:"analytics",
    label:"Analytics / Data",
    capabilities:Object.freeze(["analytics.ingest.read"]),
    suggestedScopes:Object.freeze(["analytics.read"]),
    supportsCredentialBinding:true
  },
  {
    provider:"gmail",
    label:"Gmail",
    capabilities:Object.freeze(["email.send"]),
    suggestedScopes:Object.freeze(["gmail.send","gmail.read"]),
    supportsCredentialBinding:true
  },
  {
    provider:"slack",
    label:"Slack",
    capabilities:Object.freeze(["slack.message.send"]),
    suggestedScopes:Object.freeze(["chat:write"]),
    supportsCredentialBinding:true
  },
  {
    provider:"webhook",
    label:"Webhook",
    capabilities:Object.freeze(["webhook.send"]),
    suggestedScopes:Object.freeze(["webhook.send"]),
    supportsCredentialBinding:true
  },
  {
    provider:"http",
    label:"Configured HTTPS",
    capabilities:Object.freeze(["http.request"]),
    suggestedScopes:Object.freeze(["http.request"]),
    supportsCredentialBinding:true
  }
]);

function uniqueSorted(values:readonly string[],label:string){
  const normalized=[...new Set(values.map((item)=>item.trim()).filter(Boolean))].sort();
  if(normalized.length===0||normalized.length>100||normalized.some((item)=>item.length>200)){
    throw new ControlPlaneError("VALIDATION_FAILED",`${label} must contain 1-100 bounded values`);
  }
  return Object.freeze(normalized);
}

function providerDefinition(provider:IntegrationProvider){
  const definition=INTEGRATION_PROVIDER_CATALOG.find((item)=>item.provider===provider);
  if(!definition) throw new ControlPlaneError("VALIDATION_FAILED","Integration provider is unavailable");
  return definition;
}

export function createIntegrationConfiguration(input:{
  scope:Pick<TrustedExecutionScope,"portfolioId"|"companyId"|"environment">;
  value:IntegrationConfigurationInput;
  now?:string;
}):IntegrationConfiguration{
  const definition=providerDefinition(input.value.provider);
  const displayName=input.value.displayName.trim();
  if(!/^[A-Za-z0-9][A-Za-z0-9 ._()/-]{0,119}$/.test(displayName)){
    throw new ControlPlaneError("VALIDATION_FAILED","Integration displayName is invalid");
  }
  if(!/^[A-Za-z0-9._:-]{1,160}$/.test(input.value.id)){
    throw new ControlPlaneError("VALIDATION_FAILED","Integration id is invalid");
  }
  const capabilityNames=uniqueSorted(input.value.capabilityNames,"Integration capabilities");
  if(capabilityNames.some((capability)=>!definition.capabilities.includes(capability))){
    throw new ControlPlaneError("POLICY_BLOCKED","Integration capability is not allowed for provider");
  }
  const grantedScopes=uniqueSorted(input.value.grantedScopes,"Integration granted scopes");
  const credentialBindingId=input.value.credentialBindingId?.trim();
  if(credentialBindingId && !/^[A-Za-z0-9._:@+-]{1,200}$/.test(credentialBindingId)){
    throw new ControlPlaneError("VALIDATION_FAILED","Integration credential binding reference is invalid");
  }
  const now=input.now??new Date().toISOString();
  if(!Number.isFinite(Date.parse(now))) throw new ControlPlaneError("VALIDATION_FAILED","Integration timestamp is invalid");
  const base={
    id:input.value.id,
    portfolioId:input.scope.portfolioId,
    companyId:input.scope.companyId,
    environment:input.scope.environment,
    provider:input.value.provider,
    displayName,
    capabilityNames,
    grantedScopes,
    credentialBindingId,
    status:(credentialBindingId?"disabled":"pending") as IntegrationConfigurationStatus,
    health:"unknown" as const,
    createdAt:new Date(Date.parse(now)).toISOString(),
    updatedAt:new Date(Date.parse(now)).toISOString(),
    version:1
  };
  return Object.freeze({...base,configurationHash:sha256Hex(base)});
}

export function assertIntegrationConfiguration(record:IntegrationConfiguration){
  const {configurationHash,...base}=record;
  if(
    sha256Hex(base)!==configurationHash
    || record.version<1
    || !INTEGRATION_PROVIDER_CATALOG.some((item)=>item.provider===record.provider)
  ){
    throw new ControlPlaneError("FORBIDDEN","Integration configuration integrity check failed");
  }
  return record;
}

export function transitionIntegrationConfiguration(
  record:IntegrationConfiguration,
  input:{
    action:"enable"|"disable"|"revoke";
    at:string;
  }
):IntegrationConfiguration{
  assertIntegrationConfiguration(record);
  const at=new Date(Date.parse(input.at)).toISOString();
  if(input.action==="enable"&&!record.credentialBindingId){
    throw new ControlPlaneError("POLICY_BLOCKED","Integration cannot be enabled without a brokered credential binding reference");
  }
  if(record.status==="revoked"&&input.action!=="revoke"){
    throw new ControlPlaneError("POLICY_BLOCKED","Revoked integration cannot be re-enabled");
  }
  const status:IntegrationConfigurationStatus=input.action==="enable"
    ?"active"
    : input.action==="disable"
      ?"disabled"
      :"revoked";
  const base={
    id:record.id,
    portfolioId:record.portfolioId,
    companyId:record.companyId,
    environment:record.environment,
    provider:record.provider,
    displayName:record.displayName,
    capabilityNames:record.capabilityNames,
    grantedScopes:record.grantedScopes,
    credentialBindingId:record.credentialBindingId,
    status,
    health:input.action==="enable"?record.health:"unknown" as IntegrationHealth,
    lastVerification:record.lastVerification,
    createdAt:record.createdAt,
    updatedAt:at,
    version:record.version+1
  };
  return Object.freeze({...base,configurationHash:sha256Hex(base)});
}

export function attachIntegrationVerification(
  record:IntegrationConfiguration,
  verification:IntegrationVerificationSummary
):IntegrationConfiguration{
  assertIntegrationConfiguration(record);
  if(!Number.isFinite(Date.parse(verification.verifiedAt))||!/^[a-f0-9]{64}$/.test(verification.evidenceHash)){
    throw new ControlPlaneError("VALIDATION_FAILED","Integration verification evidence is invalid");
  }
  const base={
    id:record.id,
    portfolioId:record.portfolioId,
    companyId:record.companyId,
    environment:record.environment,
    provider:record.provider,
    displayName:record.displayName,
    capabilityNames:record.capabilityNames,
    grantedScopes:record.grantedScopes,
    credentialBindingId:record.credentialBindingId,
    status:record.status,
    health:verification.health,
    lastVerification:Object.freeze({...verification,capabilityResults:Object.freeze({...verification.capabilityResults})}),
    createdAt:record.createdAt,
    updatedAt:verification.verifiedAt,
    version:record.version+1
  };
  return Object.freeze({...base,configurationHash:sha256Hex(base)});
}

export interface IntegrationConfigurationStore {
  list(scope:Pick<TrustedExecutionScope,"portfolioId"|"companyId"|"environment">):Promise<readonly IntegrationConfiguration[]>;
  get(scope:Pick<TrustedExecutionScope,"portfolioId"|"companyId"|"environment">,id:string):Promise<IntegrationConfiguration|null>;
  create(record:IntegrationConfiguration,idempotencyKey:string):Promise<IntegrationConfiguration>;
  save(record:IntegrationConfiguration,expectedVersion:number):Promise<IntegrationConfiguration>;
  appendVerification(input:{
    integrationId:string;
    scope:Pick<TrustedExecutionScope,"portfolioId"|"companyId"|"environment">;
    verification:IntegrationVerificationSummary;
  }):Promise<void>;
}
