import { handleDiscoverResource, handleListResources } from "@/lib/control-api/http";

export const dynamic = "force-dynamic";
export const GET = handleListResources;
export const POST = handleDiscoverResource;
