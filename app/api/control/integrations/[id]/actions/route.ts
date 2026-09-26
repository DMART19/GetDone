import { handleIntegrationConfigurationAction } from "@/lib/integrations/configuration-http";

export const dynamic = "force-dynamic";

export function POST(request:Request,context:{params:Promise<{id:string}>}){
  return context.params.then(({id})=>handleIntegrationConfigurationAction(request,id));
}
