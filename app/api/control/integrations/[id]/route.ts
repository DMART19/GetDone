import {
  handleGetIntegrationConfiguration,
  handleUpdateIntegrationConfiguration
} from "@/lib/integrations/configuration-http";

export const dynamic = "force-dynamic";

export function GET(request:Request,context:{params:Promise<{id:string}>}){
  return context.params.then(({id})=>handleGetIntegrationConfiguration(request,id));
}

export function PATCH(request:Request,context:{params:Promise<{id:string}>}){
  return context.params.then(({id})=>handleUpdateIntegrationConfiguration(request,id));
}
