import { handleAIGatewayHealth } from "@/lib/control-api/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return handleAIGatewayHealth(request);
}
