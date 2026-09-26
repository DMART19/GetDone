import {
  handleCreateIntegrationConfiguration,
  handleListIntegrationConfigurations
} from "@/lib/integrations/configuration-http";

export const dynamic = "force-dynamic";
export const GET = handleListIntegrationConfigurations;
export const POST = handleCreateIntegrationConfiguration;
