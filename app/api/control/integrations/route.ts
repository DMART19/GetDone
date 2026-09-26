import {
  handleCreateIntegration,
  handleListIntegrations
} from "@/lib/control-api/http";

export const dynamic = "force-dynamic";
export const GET = handleListIntegrations;
export const POST = handleCreateIntegration;
