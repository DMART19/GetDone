import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  AuthorizedBusinessActionRequest,
  BusinessActionAdapter,
  BusinessActionExecutionContext,
  BusinessActionStatus
} from "@/lib/execution/adapters/business-action";
import type {
  IntegrationConfigurationStore,
  IntegrationProvider
} from "@/lib/integrations/configuration";

export class ManagedIntegrationBusinessActionAdapter implements BusinessActionAdapter {
  readonly id:string;
  readonly version:string;

  constructor(
    private readonly provider:IntegrationProvider,
    private readonly delegate:BusinessActionAdapter,
    private readonly store:IntegrationConfigurationStore
  ){
    this.id=delegate.id;
    this.version=delegate.version;
  }

  credentialRequirement(request:AuthorizedBusinessActionRequest){
    return this.delegate.credentialRequirement?.(request)??null;
  }

  private integrationId(request:AuthorizedBusinessActionRequest){
    const input=request.input;
    if(!input||typeof input!=="object"||Array.isArray(input)) return undefined;
    const value=(input as Record<string,unknown>).connectionId
      ?? (input as Record<string,unknown>).sourceId;
    return typeof value==="string"&&value.trim()?value.trim():undefined;
  }

  private async assertEnabled(request:AuthorizedBusinessActionRequest){
    const id=this.integrationId(request);
    if(!id) return;
    const record=await this.store.get(request.scope,id);
    if(!record) return;
    if(record.provider!==this.provider){
      throw new ControlPlaneError("POLICY_BLOCKED","Managed integration provider does not match adapter provider");
    }
    if(record.status!=="active"){
      throw new ControlPlaneError(
        "POLICY_BLOCKED",
        `Managed ${record.provider} integration is ${record.status}; new provider actions are blocked`
      );
    }
    if(!record.capabilityNames.includes(request.capability)){
      throw new ControlPlaneError("POLICY_BLOCKED","Managed integration does not grant this capability");
    }
  }

  async execute(request:AuthorizedBusinessActionRequest,context?:BusinessActionExecutionContext){
    await this.assertEnabled(request);
    return this.delegate.execute(request,context);
  }

  status(
    input:{requestId:string;providerOperationId:string},
    context?:BusinessActionExecutionContext
  ):Promise<BusinessActionStatus>{
    return this.delegate.status(input,context);
  }

  cancel?(
    input:{requestId:string;providerOperationId:string;reason:string},
    context?:BusinessActionExecutionContext
  ):Promise<BusinessActionStatus>{
    if(!this.delegate.cancel){
      throw new ControlPlaneError("NOT_FOUND","Integration adapter does not support cancellation");
    }
    return this.delegate.cancel(input,context);
  }
}
