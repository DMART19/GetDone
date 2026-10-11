import { getBusinessCatalog, getBusinessContext } from "@/lib/businesses/runtime.server";
import { createCorrelationId } from "@/lib/control-plane/request-context";
import { readServerRuntimeEnvironment } from "@/lib/control-plane/runtime-environment.server";
import { toControlPlaneError } from "@/lib/control-plane/errors";
import { apiFailure, apiSuccess } from "@/lib/control-plane/schemas";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const meta = { correlationId: createCorrelationId(), environment: readServerRuntimeEnvironment() };
  const headers = { "cache-control": "no-store", "x-correlation-id": meta.correlationId };
  try {
    const portfolioId = new URL(request.url).searchParams.get("portfolioId");
    const data = portfolioId ? await getBusinessContext(request, portfolioId) : await getBusinessCatalog(request, true);
    return Response.json(apiSuccess(data, meta), { headers });
  } catch (error) {
    const normalized = toControlPlaneError(error);
    return Response.json(apiFailure(normalized.code, normalized.message, meta), { status: normalized.status, headers });
  }
}
