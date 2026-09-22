import { toControlPlaneError } from "@/lib/control-plane/errors";
import {
  assertInternalAIGatewayToken,
  runLiveOpenRouterCanary
} from "@/lib/ai-gateway/canary.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertInternalAIGatewayToken(request);
    const result = await runLiveOpenRouterCanary();
    return Response.json(
      { ok: true, data: result },
      { status: 200, headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    const normalized = toControlPlaneError(error);
    return Response.json(
      { ok: false, error: { code: normalized.code, message: normalized.message } },
      {
        status: normalized.status,
        headers: { "cache-control": "no-store" }
      }
    );
  }
}
